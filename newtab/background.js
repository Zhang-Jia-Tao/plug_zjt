// background.js — service worker
// 目录树功能中枢：目录句柄 IndexedDB 持久化、目录扫描、文件读/写、剪贴板代理。
// 页面（newtab / tree iframe / content script）全部经 chrome.runtime.sendMessage
// 走这里，句柄只在 SW 作用域流转，权限只需授予一次。
// 另含 AI 管理器 Native Messaging 端口：connectNative('ai_manager_host')
// 长连接收 host 推送（apps/message/dialog），页面订阅经 ai:subscribe 广播。

import { listDirHandles, removeDirHandle } from './js/handle-store.js';
import { scanDirectory, readFile, writeFile, createDirectory } from './js/fs-access.js';

// ---- AI 管理器：Native Messaging 端口 ----
// 页面侧用 chrome.runtime.connect({ name: 'ai:subscribe' }) 建立到 SW 的长连接；
// SW 把 host 推送的事件广播到所有订阅连接。
let aiPort = null;
const aiSubscribers = new Set(); // 页面 port（onDisconnect 自动摘除）

chrome.runtime.onConnect.addListener((pagePort) => {
  if (pagePort.name !== 'ai:subscribe') return;
  aiSubscribers.add(pagePort);
  pagePort.onDisconnect.addListener(() => {
    aiSubscribers.delete(pagePort);
    // 全部页面断开：sysmon 降频（host 侧 15s 低频轮询省 CPU）
    if (aiSubscribers.size === 0) {
      const p = aiPort;
      if (p) p.postMessage({ type: 'sysmon', fast: false });
    }
  });
  // 新订阅者：确保 host 连接活着，并立即请求一份快照
  const port = ensureAiPort();
  if (port) port.postMessage({ type: 'query' });
  else pagePort.postMessage({ action: 'ai:event', payload: { type: 'host:error', message: 'host 未连接（是否已运行 install-host.bat？）' } });
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
  return aiPort;
}

function broadcastAi(msg) {
  for (const sub of aiSubscribers) {
    try { sub.postMessage({ action: 'ai:event', payload: msg }); } catch { /* 页面已关 */ }
  }
}

function handleAiMessage(msg, sender, sendResponse) {
  switch (msg.action) {
    case 'ai:query': {
      const port = ensureAiPort();
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
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
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
