// background.js — service worker
// 目录树功能中枢：目录句柄 IndexedDB 持久化、目录扫描、文件读/写、剪贴板代理。
// 页面（newtab / tree iframe / content script）全部经 chrome.runtime.sendMessage
// 走这里，句柄只在 SW 作用域流转，权限只需授予一次。
// 另含 AI 管理器 Native Messaging 端口：connectNative('ai_manager_host')
// 长连接收 host 推送（apps/message/dialog），页面订阅经 ai:subscribe 广播。

import { listDirHandles, removeDirHandle } from './js/handle-store.js';
import { scanDirectory, readFile, writeFile, createDirectory } from './js/fs-access.js';
import { matchWebAiSite, webAiSiteById } from './js/webai-sites.js';

// ---- AI 管理器：Native Messaging 端口 ----
// 页面侧用 chrome.runtime.connect({ name: 'ai:subscribe' }) 建立到 SW 的长连接；
// SW 把 host 推送的事件广播到所有订阅连接。
let aiPort = null;
const aiSubscribers = new Set(); // 页面 port（onDisconnect 自动摘除）
let projectRoot = ''; // 组件配置的 Java 终极笔记启动目录；host 重启后用它恢复
let projectAutoFallback = true; // 显式目录失效时是否允许 host 自动探测备用目录
let noSubscriberTimer = null; // 全部页面断开后延迟降频，避免刷新页面时 false 晚于新订阅的 true
// 页面用 chrome.runtime.sendMessage 发项目命令时，在这里等 host 的 project:result。
// 这样即使页面到 SW 的长连接端口处于半死状态（能收推送、发不出命令），命令也能
// 通过一次性消息唤醒 SW 并转发，避免“点启动一直无反应/超时”。
const projectWaiters = new Map();

chrome.runtime.onConnect.addListener((pagePort) => {
  if (pagePort.name !== 'ai:subscribe') return;
  aiSubscribers.add(pagePort);
  clearTimeout(noSubscriberTimer);
  noSubscriberTimer = null;
  pagePort.onMessage.addListener((msg) => forwardProjectCommand(pagePort, msg));
  pagePort.onDisconnect.addListener(() => {
    aiSubscribers.delete(pagePort);
    // 全部页面断开：延迟再降频。设置页改动会销毁/重建 widget，
    // 旧 port 的 disconnect 可能晚于新 port 的 watch:true；立即发 false
    // 会把新实例刚开启的监控关掉（表现为一直“正在读取”）。
    if (aiSubscribers.size === 0) {
      clearTimeout(noSubscriberTimer);
      noSubscriberTimer = setTimeout(() => {
        noSubscriberTimer = null;
        if (aiSubscribers.size > 0) return;
        const p = aiPort;
        if (!p) return;
        try { p.postMessage({ type: 'sysmon', fast: false }); } catch {}
        try { p.postMessage({ type: 'project:watch', watch: false }); } catch {}
      }, 300);
    }
  });
  // 新订阅者：确保 host 连接活着，并立即请求一份快照
  const port = ensureAiPort();
  if (port) {
    try { port.postMessage({ type: 'query' }); } catch { /* host 刚断开，等重连 */ }
    // 项目监控不在这里抢发 watch：页面里的 Java 笔记组件会立刻带着
    // 自己配置的 root 发 project:watch，避免这里用旧的 projectRoot
    // 把新组件刚切好的目录又切回去。
  } else {
    pagePort.postMessage({ action: 'ai:event', payload: { type: 'host:error', message: 'host 未连接（是否已运行 install-host.bat？）' } });
  }
  sendWebAiTo(pagePort); // 网页 AI 不依赖 host，host 未安装时也要能显示
});

function ensureAiPort() {
  if (aiPort) return aiPort;
  try {
    aiPort = chrome.runtime.connectNative('ai_manager_host');
  } catch (e) {
    broadcastAi({ type: 'host:error', message: String(e && e.message || e) });
    return null;
  }
  aiPort.onMessage.addListener((msg) => broadcastAi(msg));
  aiPort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError;
    aiPort = null;
    broadcastAi({ type: 'host:error', message: (err && err.message) || 'host 断开（未安装或已退出）' });
    // 10s 后自动重连（host 可能刚被安装）
    setTimeout(ensureAiPort, 10000);
  });
  // host 重连时没有新的页面订阅事件，主动补一次 query/watch，避免面板与
  // 学习台停在旧快照上。
  if (aiSubscribers.size > 0) {
    try { aiPort.postMessage({ type: 'query' }); } catch {}
    try {
      aiPort.postMessage({
        type: 'project:watch',
        watch: true,
        root: projectRoot,
        autoFallback: projectAutoFallback,
      });
    } catch {}
  }
  return aiPort;
}

function settleProjectWaiter(msg) {
  if (!msg || msg.type !== 'project:result' || !msg.requestId) return;
  const waiter = projectWaiters.get(msg.requestId);
  if (!waiter) return;
  projectWaiters.delete(msg.requestId);
  clearTimeout(waiter.timer);
  try { waiter.sendResponse(msg); } catch { /* 页面已关闭 */ }
}

function forwardProjectMessage(msg, sendResponse) {
  if (!msg || typeof msg !== 'object') return false;
  if (msg.action === 'project:watch') {
    if (typeof msg.root === 'string') projectRoot = msg.root.trim();
    if (typeof msg.autoFallback === 'boolean') projectAutoFallback = msg.autoFallback;
    const p = ensureAiPort();
    if (p) {
      try {
        p.postMessage({
          type: 'project:watch',
          watch: msg.watch !== false,
          root: projectRoot,
          autoFallback: projectAutoFallback,
        });
      } catch {}
    }
    try { sendResponse({ ok: !!p }); } catch {}
    return false;
  }
  if (msg.action !== 'project:command') return false;
  if (typeof msg.root === 'string') projectRoot = msg.root.trim();
  if (typeof msg.autoFallback === 'boolean') projectAutoFallback = msg.autoFallback;
  const requestId = msg.requestId;
  const port = ensureAiPort();
  if (!port) {
    try {
      sendResponse({
        ok: false,
        error: { code: 'host_offline', message: 'host 未连接（是否已运行 install-host.bat？）' },
      });
    } catch {}
    return false;
  }
  const timer = setTimeout(() => {
    if (!projectWaiters.delete(requestId)) return;
    try {
      sendResponse({
        ok: false,
        error: { code: 'host_timeout', message: 'host 响应超时（后台已重连，请重试）' },
      });
    } catch {}
    // host 可能已经被 Chrome 回收但端口对象还在，主动断掉让 onDisconnect 重连。
    try { aiPort?.disconnect(); } catch {}
  }, 60_000);
  projectWaiters.set(requestId, { sendResponse, timer });
  try {
    port.postMessage({
      type: 'project:command',
      requestId,
      root: projectRoot,
      autoFallback: projectAutoFallback,
      command: String(msg.command || ''),
      payload: msg.payload && typeof msg.payload === 'object' ? msg.payload : {},
    });
  } catch (e) {
    projectWaiters.delete(requestId);
    clearTimeout(timer);
    try {
      sendResponse({
        ok: false,
        error: { code: 'host_send_failed', message: String(e && e.message || e) },
      });
    } catch {}
  }
  return true;
}

function broadcastAi(msg) {
  settleProjectWaiter(msg);
  for (const sub of aiSubscribers) {
    try { sub.postMessage({ action: 'ai:event', payload: msg }); } catch { /* 页面已关 */ }
  }
}

// 页面 → host 的项目命令转发。页面只提交命令名和少量布尔/数字参数，
// 真正的项目路径、启动脚本、进程白名单都在 host 侧硬编码，扩展不能传任意命令。
function forwardProjectCommand(pagePort, msg) {
  if (!msg) return;
  if (msg.action === 'project:watch') {
    if (typeof msg.root === 'string') projectRoot = msg.root.trim();
    if (typeof msg.autoFallback === 'boolean') projectAutoFallback = msg.autoFallback;
    const p = ensureAiPort();
    if (!p) return;
    try {
      p.postMessage({
        type: 'project:watch',
        watch: msg.watch !== false,
        root: projectRoot,
        autoFallback: projectAutoFallback,
      });
    } catch { /* host 刚断开，等 reconnect 时补发 */ }
    return;
  }
  if (msg.action !== 'project:command') return;
  if (typeof msg.root === 'string') projectRoot = msg.root.trim();
  if (typeof msg.autoFallback === 'boolean') projectAutoFallback = msg.autoFallback;
  const requestId = msg.requestId;
  const port = ensureAiPort();
  if (!port) {
    pagePort.postMessage({
      action: 'ai:event',
      payload: {
        type: 'project:result',
        requestId,
        ok: false,
        error: { code: 'host_offline', message: 'host 未连接（是否已运行 install-host.bat？）' },
      },
    });
    return;
  }
  try {
    port.postMessage({
      type: 'project:command',
      requestId,
      root: projectRoot,
      autoFallback: projectAutoFallback,
      command: String(msg.command || ''),
      payload: msg.payload && typeof msg.payload === 'object' ? msg.payload : {},
    });
  } catch (e) {
    pagePort.postMessage({
      action: 'ai:event',
      payload: {
        type: 'project:result',
        requestId,
        ok: false,
        error: { code: 'host_send_failed', message: String(e && e.message || e) },
      },
    });
  }
}

// ---- 网页 AI：content script 上报 → SW 按 tab 聚合 ----
// 网页状态不经过 Native Messaging；host 未安装时也能工作。
const webAiTabs = new Map(); // tabId → {app,status,title,active,url,lastTs,activityTs}
const WEB_AI_TTL_MS = 45_000;
// content 已经要求“Stop/aria-busy 出现后仍有真实活动”；这里再做一层超时兜底，
// 防止旧版 content script 或丢失心跳把 tasking 永久挂住。
const WEB_AI_TASK_IDLE_MS = 10_000;
let lastWebAiJson = '';

// 标签冻结/内容脚本失效/页面崩溃后不会再上报，靠 TTL 把僵尸卡片清掉。
function pruneStaleWebAi(now = Date.now()) {
  let changed = false;
  for (const [tabId, st] of webAiTabs) {
    if (!st.lastTs || now - st.lastTs > WEB_AI_TTL_MS) {
      webAiTabs.delete(tabId);
      changed = true;
    }
  }
  return changed;
}

function cleanWebTitle(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, 100);
}

function buildWebApps() {
  pruneStaleWebAi();
  const groups = new Map();
  for (const [tabId, st] of webAiTabs) {
    const site = webAiSiteById(st.app);
    if (!site) continue;
    let group = groups.get(site.id);
    if (!group) {
      group = { site, tabs: [] };
      groups.set(site.id, group);
    }
    group.tabs.push({ tabId, ...st });
  }

  const apps = [];
  for (const { site, tabs } of groups.values()) {
    const now = Date.now();
    const active = tabs.find(t => t.active);
    const tasking = tabs.find(t => t.status === 'tasking'
      && Number(t.activityTs) > 0
      && now - Number(t.activityTs) < WEB_AI_TASK_IDLE_MS);
    // 同一站点多标签：优先聚焦正在生成的标签，其次当前活动标签
    const focus = tasking || active
      || tabs.slice().sort((a, b) => b.lastTs - a.lastTs)[0];
    const title = focus.title || site.name;
    const activeTitle = active && active.title;
    const detail = tabs.length > 1
      ? `${tabs.length} 个标签页${activeTitle ? ' · ' + activeTitle : ''}`
      : (focus.title || site.detail || title);
    const lastTs = Math.max(...tabs.map(t => t.lastTs || 0));
    apps.push({
      id: site.id,
      name: site.name,
      status: tasking ? 'tasking' : 'online',
      active: !!active,
      tabId: focus.tabId,
      title,
      detail,
      color: site.color,
      short: site.short,
      url: focus.url,
      lastTs,
      // 只在主内容区真的有新增节点时更新；心跳不冒充“会话活动”。
      lastActivity: Math.max(0, ...tabs.map(t => t.activityTs || 0)),
    });
  }

  return apps.sort((a, b) =>
    (b.status === 'tasking') - (a.status === 'tasking')
    || (b.active ? 1 : 0) - (a.active ? 1 : 0)
    || b.lastTs - a.lastTs);
}

// lastTs 每次心跳都会变，但不影响卡片内容；签名不包含它，避免 3.5s 心跳重画一次
function webAiSignature(apps) {
  return JSON.stringify(apps.map(a => ({
    id: a.id,
    status: a.status,
    active: a.active,
    tabId: a.tabId,
    title: a.title,
    detail: a.detail,
    // 最近活动按 2s 分桶：活跃会话可更快刷新 UI，但不会每次心跳都重画。
    activity: Math.floor((a.lastActivity || 0) / 2000),
  })));
}

function broadcastWebAi(force = false) {
  const apps = buildWebApps();
  const sig = webAiSignature(apps);
  if (!force && sig === lastWebAiJson) return;
  lastWebAiJson = sig;
  broadcastAi({ type: 'webai', apps });
}

// 新订阅者必须收到当前网页状态，即使签名与上一次广播相同
function sendWebAiTo(pagePort) {
  pruneStaleWebAi();
  try {
    pagePort.postMessage({ action: 'ai:event', payload: { type: 'webai', apps: buildWebApps() } });
  } catch { /* 页面已关 */ }
}

function handleWebAiState(msg, sender, sendResponse) {
  const tab = sender && sender.tab;
  const p = (msg && msg.payload) || {};
  if (!tab || typeof tab.id !== 'number' || tab.id < 0) {
    sendResponse({ ok: false, message: '缺少来源标签页' });
    return;
  }
  let tabHost = '';
  try { tabHost = new URL(tab.url || '').hostname; } catch { tabHost = ''; }
  let host = tabHost;
  if (!host) {
    try { host = p.host || new URL(p.url || '').hostname; } catch { host = ''; }
  }
  const site = matchWebAiSite(host);
  if (!site) {
    if (webAiTabs.delete(tab.id)) broadcastWebAi(true);
    sendResponse({ ok: false, message: '非受支持站点' });
    return;
  }
  webAiTabs.set(tab.id, {
    app: site.id,
    status: p.status === 'tasking' ? 'tasking' : 'online',
    title: cleanWebTitle(p.title),
    // sender.tab.active 比页面 visibilityState 更可靠（后台窗口/预渲染时）
    active: typeof tab.active === 'boolean' ? tab.active : !!p.active,
    url: String(p.url || tab.url || '').slice(0, 300),
    lastTs: Date.now(),
    activityTs: Number(p.activityTs) > 0 ? Number(p.activityTs) : 0,
  });
  broadcastWebAi();
  sendResponse({ ok: true });
}

function handleWebAiFocus(payload, sendResponse) {
  const tabId = Number(payload && payload.tabId);
  if (!Number.isInteger(tabId) || !webAiTabs.has(tabId)) {
    sendResponse({ ok: false, message: '标签页已关闭' });
    return;
  }
  // onMessage 的异步包装没有返回 true，异步回调里的 sendResponse 可能已失效；
  // 焦点操作本身不需要 UI 等结果，先确认已接受，再异步切标签。
  sendResponse({ ok: true });
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab) return;
    chrome.tabs.update(tabId, { active: true }, () => { void chrome.runtime.lastError; });
    if (typeof tab.windowId === 'number') {
      chrome.windows.update(tab.windowId, { focused: true }, () => { void chrome.runtime.lastError; });
    }
  });
}

function pruneWebAiTab(tabId) {
  if (webAiTabs.delete(tabId)) broadcastWebAi(true);
}

// 标签切换/页面重新可见时，主动向 content script 要一次当前状态，
// 比等下一次 3.5s 心跳更快；失败说明脚本未注入，静默等心跳。
function pingWebAiTab(tabId) {
  if (!webAiTabs.has(tabId)) return;
  chrome.tabs.sendMessage(tabId, { action: 'ai:web-ping' }, () => {
    void chrome.runtime.lastError;
  });
}

chrome.tabs.onRemoved.addListener((tabId) => pruneWebAiTab(tabId));
chrome.tabs.onActivated.addListener(({ tabId }) => {
  let changed = false;
  for (const [id, st] of webAiTabs) {
    const active = id === tabId;
    if (st.active !== active) { st.active = active; changed = true; }
  }
  pingWebAiTab(tabId);
  if (changed) broadcastWebAi(true);
});
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.discarded) { pruneWebAiTab(tabId); return; }
  if (!info.url && info.status !== 'complete') return;
  const url = (tab && tab.url) || '';
  let host = '';
  try { host = new URL(url).hostname; } catch { host = ''; }
  const site = matchWebAiSite(host);
  if (!site) { pruneWebAiTab(tabId); return; }
  const prev = webAiTabs.get(tabId);
  if (prev && prev.app !== site.id) pruneWebAiTab(tabId);
  if (info.status === 'complete') {
    setTimeout(() => pingWebAiTab(tabId), 250);
  }
});

function handleAiMessage(msg, sender, sendResponse) {
  switch (msg.action) {
    case 'ai:web-state': {
      handleWebAiState(msg, sender, sendResponse);
      break;
    }
    case 'ai:web-focus': {
      handleWebAiFocus(msg.payload, sendResponse);
      break;
    }
    case 'ai:query': {
      const port = ensureAiPort();
      for (const tabId of webAiTabs.keys()) pingWebAiTab(tabId);
      broadcastWebAi(true); // 手动刷新也同步刷新网页 AI
      if (!port) { sendResponse({ ok: false, message: 'host 未连接' }); break; }
      port.postMessage({ type: 'query' });
      sendResponse({ ok: true });
      break;
    }
    case 'ai:sysmon': {
      // 页面通知 sysmon 高频/低频（host 侧去重，所有订阅者共享）
      const port = ensureAiPort();
      if (port) port.postMessage({ type: 'sysmon', fast: !!msg.fast });
      sendResponse({ ok: true });
      break;
    }
    case 'ai:respond': {
      const port = ensureAiPort();
      if (!port) { sendResponse({ ok: false, message: 'host 未连接' }); break; }
      port.postMessage({ type: 'dialog:respond', dialogId: msg.payload.dialogId, buttonId: msg.payload.buttonId });
      sendResponse({ ok: true });
      break;
    }
    default:
      sendResponse({ ok: false, message: `未知 ai: 操作：${msg.action}` });
  }
}

// ---- 消息路由 ----
// 项目命令/监控走一次性消息：唤醒 SW 即可，不依赖页面长连接端口的上行是否健康。
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && (msg.action === 'project:command' || msg.action === 'project:watch')) {
    return forwardProjectMessage(msg, sendResponse);
  }
  return false;
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      // 项目命令由上面的专用 listener 处理，这里不响应，避免提前关闭消息通道。
      if (msg && (msg.action === 'project:command' || msg.action === 'project:watch')) return;
      // AI 管理器消息优先单独处理
      if (msg && String(msg.action || '').startsWith('ai:')) {
        handleAiMessage(msg, sender, sendResponse);
        return;
      }
      switch (msg?.action) {
        case 'bm:navigate': {
          // 书签栏跳转代理：chrome:// 等内部页面无法由网页 location 跳转，
          // 必须 tabs API（newtab 也不能 update，只能开新标签）
          const url = msg.payload.url;
          try {
            if (/^chrome:\/\/(newtab|new-tab-page)/i.test(url)) {
              await chrome.tabs.create({}); // 无 url = 默认新标签页
            } else {
              const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
              await chrome.tabs.update(tab.id, { url });
            }
          } catch {
            try { await chrome.tabs.create({ url }); } catch { /* 无效 URL 放弃 */ }
          }
          sendResponse({ ok: true });
          break;
        }
        case 'music:scan': {
          // 音乐小组件：列出目录下全部音频文件（含子目录一层）
          const res = await scanDirectory(msg.payload.dirId, msg.payload.path || []);
          const AUDIO_EXT = ['flac', 'mp3', 'm4a', 'ogg', 'wav', 'aac', 'opus'];
          const songs = res.files
            .filter(f => AUDIO_EXT.includes((f.name.split('.').pop() || '').toLowerCase()))
            .map(f => ({ name: f.name, size: f.size }));
          sendResponse({ ok: true, data: { dirName: res.dirName, songs, total: songs.length } });
          break;
        }
        case 'music:read':
          // 已废弃：音频大文件改由 newtab 页面直接从 IDB 句柄读取（不过 SW）
          sendResponse({ ok: false, message: '音频文件由页面直读，无需走 SW' });
          break;
        case 'tree:changed-broadcast':
          // 页面已把句柄直接写入共享 IDB（消息通道无法序列化句柄），
          // 这里只负责广播让所有 tree iframe 刷新列表
          broadcastTreeChanged();
          sendResponse({ ok: true });
          break;
        case 'tree:mkdir':
          sendResponse({ ok: true, data: await createDirectory(msg.payload.dirId, msg.payload.path || [], msg.payload.name) });
          break;
        case 'tree:dirs': {
          const list = await listDirHandles();
          sendResponse({ ok: true, data: list.map(e => ({ id: e.id, name: e.name })) });
          break;
        }
        case 'tree:unmount':
          await removeDirHandle(msg.payload.dirId);
          sendResponse({ ok: true });
          broadcastTreeChanged();
          break;
        case 'tree:open-picker':
          // 小窗打开 file-picker（showDirectoryPicker 需要页面用户手势）
          chrome.windows.create({
            url: 'file-picker.html',
            type: 'popup',
            width: 420,
            height: 240,
          });
          sendResponse({ ok: true });
          break;
        case 'tree:pick':
          // 兼容保留：file-picker 页直接注册句柄（tree:register）
          sendResponse({ ok: false, message: '请通过目录树面板的 ＋ 按钮添加目录' });
          break;
        case 'tree:list':
          sendResponse({ ok: true, data: await scanDirectory(msg.payload.dirId, msg.payload.path || []) });
          break;
        case 'tree:read':
          sendResponse({ ok: true, data: await readFile(msg.payload.dirId, msg.payload.path || [], msg.payload.fileName) });
          break;
        case 'tree:write':
          sendResponse({ ok: true, data: await writeFile(msg.payload.dirId, msg.payload.path || [], msg.payload.fileName, msg.payload.content) });
          break;
        case 'tree:clipboard-read':
          sendResponse(await clipboardRead());
          break;
        case 'tree:clipboard-write':
          sendResponse(await clipboardWrite(msg.payload.text));
          break;
        default:
          sendResponse({ ok: false, message: `未知操作：${msg?.action}` });
      }
    } catch (e) {
      sendResponse({ ok: false, message: String(e && e.message || e) });
    }
  })();
  return true; // 异步响应
});

// ---- 快捷键：任意标签页唤出/收起侧边栏 ----
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-tree') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.id) return;
  chrome.tabs.sendMessage(tab.id, { action: 'content:toggle-tree' }, () => {
    void chrome.runtime.lastError; // 页面无 content script 时静默
  });
});

// ---- 剪贴板代理 ----
// 扩展页面（tree iframe）有 host 权限时可直接用 Clipboard API；content script 页面
// 的剪贴板属于页面而非扩展，读需走 offscreen 文档代持焦点。
async function clipboardRead() {
  // 先试 SW/扩展页直接读（Chrome 111+ SW 不支持 navigator.clipboard，走 offscreen）
  const off = await ensureOffscreen();
  if (!off.ok) return off;
  return withTimeout(
    chrome.runtime.sendMessage({ action: 'offscreen:clipboard-read' }),
    1500,
    '读取剪贴板超时（页面可能未授予剪贴板权限）'
  );
}

async function clipboardWrite(text) {
  const off = await ensureOffscreen();
  if (!off.ok) return off;
  return withTimeout(
    chrome.runtime.sendMessage({ action: 'offscreen:clipboard-write', payload: { text } }),
    1500,
    '写剪贴板超时'
  );
}

// 剪贴板读写需要聚焦的文档，SW 没有焦点 → 创建 offscreen 文档代持
async function ensureOffscreen() {
  try {
    const existing = await chrome.offscreen.hasDocument();
    if (existing) return { ok: true };
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['CLIPBOARD'],
      justification: '目录树文件复制/粘贴需要读写系统剪贴板',
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, message: `offscreen 创建失败：${String(e && e.message || e)}` };
  }
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => {
      if (!done) { done = true; resolve({ ok: false, message }); }
    }, ms);
    promise.then((r) => {
      if (done) return; // 已超时，丢弃
      done = true;
      clearTimeout(t);
      resolve(r);
    }).catch(() => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve({ ok: false, message });
    });
  });
}

// 目录结构变化时通知所有打开的 tree iframe
function broadcastTreeChanged() {
  chrome.runtime.sendMessage({ action: 'tree:changed' }, () => {
    void chrome.runtime.lastError; // 无监听时静默
  });
}

// ---- 页面加载完成时把当前已选目录的摘要推给 content script（如有） ----
// （省略：content script 打开侧栏时会主动 tree:list 拉取，无需推送）
