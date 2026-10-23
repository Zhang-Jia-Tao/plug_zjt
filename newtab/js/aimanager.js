// aimanager.js — 右侧固定 AI 应用管理面板
// 依赖本地伴侣程序 ai_manager_host（Native Messaging，需先 install-host.bat 安装）。
// 数据链路：本页 --runtime.connect--> SW --connectNative--> host；
// host 推送 apps / message / dialog 事件经 SW 广播回本页。
// 弹窗确认/否认：ai:respond 发给 SW → host 遥控点击白名单进程的弹窗按钮。

const APP_ICONS = {
  'claude-code': '🤖', 'ollama': '🦙', 'lmstudio': '🧠',
  'claude-desktop': '✳', 'chatgpt': '◎', cursor: '⌨',
};

let port = null;           // 到 SW 的订阅连接
let apps = [];             // [{id,name,status,detail}]
let messages = [];         // 最近消息（host snapshot + 增量）
const dialogs = new Map(); // id → dialog 对象
let activeApp = null;      // 当前查看消息流的应用（null = 总览）

// 会话状态：'idle' 空闲 / 'tasking' 实现中 / 'done' 完毕（任务结束后保持，收到新 user 消息回到 tasking）
let sessionState = 'idle';
let lastDoneAt = 0;        // 上次「完毕」时间戳（判定新会话开始：完毕超过 5 分钟后新 user 消息 → 新会话）
let messagesRendered = 0;  // 已渲染进消息流的消息数（增量渲染用）
let renderedFeedApp = undefined; // 消息流当前筛选的应用（undefined=未渲染过）

export function initAiManager() {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  document.body.classList.add('ai-panel-on');
  render();          // 先画骨架（未连接态）
  renderStreamFull();
  connect();         // 常驻面板：加载即连接
}

// ---- 连接（SW/host 断开后自动重连，避免面板假死） ----
let reconnectTimer = null;
let reconnectDelay = 1000;

function connect() {
  if (port) return;
  port = chrome.runtime.connect({ name: 'ai:subscribe' });
  port.onMessage.addListener((m) => {
    if (m && m.action === 'ai:event') onEvent(m.payload);
  });
  port.onDisconnect.addListener(() => {
    port = null;
    // host 崩溃/SW 被杀都会走到这里：指数退避重连（上限 15s），面板保持可用
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      connect();
    }, reconnectDelay);
  });
}

function onEvent(ev) {
  if (!ev || !ev.type) return;
  switch (ev.type) {
    case 'snapshot':
      reconnectDelay = 1000; // 收到数据说明链路健康，重置退避
      apps = ev.apps || [];
      messages = ev.messages || [];
      for (const d of (ev.dialogs || [])) dialogs.set(d.id, d);
      syncSessionStateFromMessages();
      hideBanner();
      renderStreamFull(); // 快照整体替换消息流
      break;
    case 'apps':
      apps = ev.apps || apps;
      break;
    case 'message':
      messages.push(ev);
      if (messages.length > 400) messages.splice(0, messages.length - 400);
      updateSessionState(ev);
      renderStreamAppend(ev); // 增量插入，不全量重画
      break;
    case 'dialog':
      dialogs.set(ev.id, ev);
      break;
    case 'dialog:closed':
      dialogs.delete(ev.id);
      break;
    case 'host:error':
      showBanner(`主机未连接：${ev.message}`);
      return;
    case 'host:ready':
      hideBanner();
      return;
    default:
      return;
  }
  render();
}

// ---- 会话状态机 ----
// tasking：收到 assistant 消息（AI 正在产出）或 user 消息（新任务下发）
// done：收到 host 的 result 完成事件（done:true）
function updateSessionState(msg) {
  if (msg.app !== 'claude-code') return;
  if (msg.done) {
    sessionState = 'done';
    lastDoneAt = Date.now();
  } else if (msg.role === 'user') {
    // 「完毕」超过 5 分钟后的新 user 消息 = 新会话；否则是同一会话的追加指令
    if (sessionState !== 'tasking' && Date.now() - lastDoneAt > 5 * 60 * 1000) sessionState = 'tasking';
    else if (sessionState !== 'done') sessionState = 'tasking';
  } else if (msg.role === 'assistant') {
    sessionState = 'tasking';
  }
}

// snapshot 回放：扫描历史消息推断当前状态（末尾 done → 完毕；末尾 assistant → 实现中）
function syncSessionStateFromMessages() {
  sessionState = 'idle';
  lastDoneAt = 0;
  for (const m of messages) updateSessionState(m);
}

function statusText() {
  return sessionState === 'tasking' ? '实现中' : sessionState === 'done' ? '完毕' : '空闲';
}

function showBanner(text) {
  const el = document.getElementById('ai-banner');
  if (el) { el.textContent = text; el.classList.remove('hidden'); }
}
function hideBanner() {
  const el = document.getElementById('ai-banner');
  if (el) el.classList.add('hidden');
}

// ---- 渲染 ----
// 增量策略：sessionState 变化才重画头部状态/运行条；应用列表按 apps 引用变化重画；
// 消息流只在「新消息到达」时插入一条 DOM 节点（避免每秒全量 innerHTML 重建 80 条卡片）。
let lastAppsRef = null;
let lastSessionState = null;

function render() {
  const list = document.getElementById('ai-app-list');
  const stream = document.getElementById('ai-stream');
  const dlgList = document.getElementById('ai-dialog-list');
  if (!list || !stream) return;

  // 头部状态徽标 + 运行条：状态变化才更新
  if (sessionState !== lastSessionState) {
    lastSessionState = sessionState;
    const status = document.getElementById('ai-status');
    if (status) {
      status.textContent = statusText();
      status.className = 'ai-status ' + sessionState;
    }
    setRunbar();
  }

  // 应用列表：apps 数组引用变化才重画（host 只在状态变化时才发新数组）
  if (apps !== lastAppsRef) {
    lastAppsRef = apps;
    list.innerHTML = apps.length === 0
      ? '<div class="ai-empty">等待主机上报…<br/>若长时间无响应，请确认已运行 install-host.bat</div>'
      : apps.map(a => `
        <button class="ai-app ${a.status} ${activeApp === a.id ? 'active' : ''}" data-app="${a.id}">
          <span class="ai-app-icon">${APP_ICONS[a.id] || '·'}</span>
          <span class="ai-app-info">
            <span class="ai-app-name">${escapeHtml(a.name)}</span>
            <span class="ai-app-detail">${escapeHtml(a.detail || '')}</span>
          </span>
          <span class="ai-app-dot" title="${a.status}"></span>
        </button>
      `).join('');
  }

  // 弹窗通知：数量小，直接重画
  if (dlgList) {
    dlgList.innerHTML = dialogs.size === 0
      ? ''
      : [...dialogs.values()].map(d => `
        <div class="ai-dialog">
          <div class="ai-dialog-title">🔔 ${escapeHtml(appName(d.app))} · ${escapeHtml(d.title || '对话框')}</div>
          <div class="ai-dialog-btns">
            ${(d.buttons || []).map(b => `
              <button class="ai-dialog-btn" data-dlg="${d.id}" data-btn="${escapeAttr(b.id)}">${escapeHtml(b.label)}</button>
            `).join('')}
          </div>
        </div>
      `).join('');
  }
}

// 全量重画消息流（snapshot 到达 / 切换应用筛选时用）
function renderStreamFull() {
  const stream = document.getElementById('ai-stream');
  if (!stream) return;
  const feed = activeApp ? messages.filter(m => m.app === activeApp) : messages;
  const tail = feed.slice(-80).reverse();
  stream.innerHTML = runbarHtml()
    + (tail.length === 0
      ? '<div class="ai-empty">暂无消息</div>'
      : tail.map(m => msgHtml(m)).join(''));
  stream.scrollTop = 0; // 最新消息在顶部
  messagesRendered = messages.length;
  renderedFeedApp = activeApp;
}

// 增量插入一条消息（新 message 事件到达时用：只 prepend 一个节点）
function renderStreamAppend(msg) {
  const stream = document.getElementById('ai-stream');
  if (!stream) return;
  if (activeApp && msg.app !== activeApp) return; // 当前筛选下不显示
  // 清掉空态占位
  const empty = stream.querySelector('.ai-empty');
  if (empty) empty.remove();
  const node = document.createElement('div');
  node.innerHTML = msgHtml(msg);
  stream.insertBefore(node.firstElementChild, anchorAfterRunbar(stream));
  // 超出 80 条移除最旧（尾部）
  const msgs = stream.querySelectorAll('.ai-msg');
  if (msgs.length > 80) msgs[msgs.length - 1].remove();
  stream.scrollTop = 0;
}

// 运行条之后插入（运行条吸顶永远第一）
function anchorAfterRunbar(stream) {
  const runbar = stream.querySelector('.ai-runbar');
  return runbar ? runbar.nextSibling : stream.firstChild;
}

function runbarHtml() {
  return sessionState === 'tasking'
    ? '<div class="ai-runbar"><span class="ai-runbar-spinner"></span>实现中…</div>'
    : sessionState === 'done'
      ? '<div class="ai-runbar finished">✓ 完毕</div>'
      : '';
}

// 更新运行条内容（状态切换时只动这一个节点）
function setRunbar() {
  const stream = document.getElementById('ai-stream');
  if (!stream) return;
  const old = stream.querySelector('.ai-runbar');
  if (old) old.remove();
  if (sessionState === 'idle') return;
  stream.insertAdjacentHTML('afterbegin', runbarHtml());
}

function msgHtml(m) {
  return `
    <div class="ai-msg role-${m.role} ${m.done ? 'done' : ''}">
      <span class="ai-msg-app">${APP_ICONS[m.app] || '·'} ${escapeHtml(appName(m.app))}</span>
      ${m.done ? '<span class="ai-msg-done">✓ 完成</span>' : ''}
      <div class="ai-msg-text">${escapeHtml(m.text)}</div>
    </div>
  `;
}

function appName(id) {
  const a = apps.find(x => x.id === id);
  return a ? a.name : id;
}

// ---- 交互（事件委托，渲染后不用重挂） ----
document.addEventListener('click', (e) => {
  // 切换应用筛选
  const appBtn = e.target.closest('.ai-app');
  if (appBtn) {
    activeApp = activeApp === appBtn.dataset.app ? null : appBtn.dataset.app;
    render();          // 应用列表高亮更新
    renderStreamFull(); // 消息流按新筛选全量重画
    return;
  }
  // 弹窗按钮 → 确认/否认
  const btn = e.target.closest('.ai-dialog-btn');
  if (btn) {
    btn.disabled = true;
    chrome.runtime.sendMessage({
      action: 'ai:respond',
      payload: { dialogId: +btn.dataset.dlg, buttonId: btn.dataset.btn },
    }, () => { void chrome.runtime.lastError; });
    return;
  }
  // 主动刷新
  const refresh = e.target.closest('#ai-refresh');
  if (refresh) {
    chrome.runtime.sendMessage({ action: 'ai:query' }, () => { void chrome.runtime.lastError; });
  }
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
