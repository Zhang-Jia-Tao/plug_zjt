// aimanager.js — 右侧固定 AI 应用管理面板
// 依赖本地伴侣程序 ai_manager_host（Native Messaging，需先 install-host.bat 安装）。
// 数据链路：本页 --runtime.connect--> SW --connectNative--> host；
// host 推送 apps / message / dialog / session 事件经 SW 广播回本页。
// 弹窗确认/否认：ai:respond 发给 SW → host 遥控点击白名单进程的弹窗按钮。
// UI 结构：应用列表 + 弹窗通知 + 会话统计卡（不渲染完整对话历史）。

// 官方品牌图标（simple-icons 单路径 SVG，currentColor 填充随主题变色）
const APP_ICONS = {
  'claude-code': 'img/apps/claude.svg',
  codex: 'img/apps/chatgpt.svg',
  ollama: 'img/apps/ollama.svg',
  lmstudio: 'img/apps/lmstudio.svg',
  'claude-desktop': 'img/apps/claude-desktop.svg',
  cursor: 'img/apps/cursor.svg',
};

// 图标 HTML：SVG 经 <img> 加载无法继承 currentColor（外链 SVG 是独立文档），
// 这里用 <object> 不合适——直接内联不了外链。取巧：用 mask 让 SVG 当形状用，
// background 色随 .ai-app-icon 的 color 变化，离线灰化也生效。
function appIconHtml(id) {
  const src = APP_ICONS[id];
  if (!src) return '<span class="ai-app-icon-fallback">·</span>';
  return `<span class="ai-app-icon" style="-webkit-mask-image:url('${src}');mask-image:url('${src}')"></span>`;
}

let port = null;           // 到 SW 的订阅连接
let apps = [];             // [{id,name,status,detail}]
let sessions = [];         // [{app,id,project,model,sumIn,sumCacheRead,sumOut,turns,lastTs}]
const dialogs = new Map(); // id → dialog 对象
// 各应用会话状态（head 徽标用）：app → 'idle' | 'tasking' | 'done'
const sessionStates = { 'claude-code': 'idle', codex: 'idle' };

export function initAiManager() {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  document.body.classList.add('ai-panel-on');
  render();
  renderSessionStats();
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
      for (const d of (ev.dialogs || [])) dialogs.set(d.id, d);
      // 快照内消息只驱动会话状态机（不渲染历史）
      for (const app of Object.keys(sessionStates)) sessionStates[app] = 'idle';
      for (const m of (ev.messages || [])) updateSessionState(m);
      sessions = ev.sessions || sessions;
      hideBanner();
      break;
    case 'apps':
      apps = ev.apps || apps;
      break;
    case 'message':
      updateSessionState(ev); // 实时消息只更新状态徽标
      break;
    case 'session':
      sessions = ev.sessions || [];
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

// ---- 会话状态机（按 app 分别维护：claude-code / codex） ----
// tasking：收到 assistant 消息（AI 正在产出）或新会话的 user 消息
// done：收到 host 的完成事件（done:true）
// 判定基准统一用消息内容，snapshot 回放和实时推送走同一条 updateSessionState。
function updateSessionState(msg) {
  const state = sessionStates[msg.app];
  if (state === undefined) return; // 无会话状态语义的应用（ollama 等在线/离线即足够）
  if (msg.done) {
    sessionStates[msg.app] = 'done';
  } else if (msg.role === 'user') {
    // user 消息在「完毕」之后 = 新一轮任务开始（终端/桌面会话持续存在，
    // user 只出现在任务真正下发的时刻，无需 5 分钟窗口）
    if (state !== 'tasking') sessionStates[msg.app] = 'tasking';
  } else if (msg.role === 'assistant') {
    // assistant 产出中；若上一状态已是 done，说明完成之后又来新输出（新任务开始）
    sessionStates[msg.app] = 'tasking';
  }
}

// head 徽标聚合：任一应用在产出即「实现中」，否则任一刚完成即「完毕」，否则「空闲」
function statusText() {
  const states = Object.values(sessionStates);
  if (states.includes('tasking')) return '实现中';
  if (states.includes('done')) return '完毕';
  return '空闲';
}

// 徽标样式 class 与聚合状态对应（idle 淡色、tasking 主题色、done 强调色）
function statusClassOf() {
  const states = Object.values(sessionStates);
  if (states.includes('tasking')) return 'tasking';
  if (states.includes('done')) return 'done';
  return 'idle';
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
// 增量策略：会话状态变化才重画状态徽标；应用列表按 apps 引用变化重画；
// 会话统计只在 stats 引用/内容变化时重画（host 推 session 事件节流）。
let lastAppsRef = null;
let lastStatusText = null;
let lastStatsJson = '';

function render() {
  const list = document.getElementById('ai-app-list');
  const dlgList = document.getElementById('ai-dialog-list');
  if (!list) return;

  // 头部状态徽标：聚合状态文本变化才更新
  const text = statusText();
  if (text !== lastStatusText) {
    lastStatusText = text;
    const status = document.getElementById('ai-status');
    if (status) {
      status.textContent = text;
      status.className = 'ai-status ' + statusClassOf();
    }
  }

  // 应用列表：apps 数组引用变化才重画（host 只在状态变化时才发新数组）
  if (apps !== lastAppsRef) {
    lastAppsRef = apps;
    list.innerHTML = apps.length === 0
      ? '<div class="ai-empty">等待主机上报…<br/>若长时间无响应，请确认已运行 install-host.bat</div>'
      : apps.map(a => `
        <div class="ai-app ${a.status}">
          ${appIconHtml(a.id)}
          <span class="ai-app-info">
            <span class="ai-app-name">${escapeHtml(a.name)}</span>
            <span class="ai-app-detail">${escapeHtml(a.detail || '')}</span>
          </span>
          <span class="ai-app-dot" title="${a.status}"></span>
        </div>
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

  renderSessionStats();
}

// ---- 会话统计（多会话列表，替代完整对话历史） ----
// 同模型的不同会话按「项目目录 + 会话短 id + 最近请求」区分，最新在前。
// token 数值格式化：千位以上显示 k（1.2k），百万显示 M
function fmtTokens(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '--';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

// 最近请求时间：host 的 ISO 时间戳 → 相对时间（刚刚 / N 分钟前 / HH:MM）
function fmtLastRequest(iso) {
  if (!iso) return '--';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '--';
  const diff = Date.now() - t;
  if (diff < 60e3) return '刚刚';
  if (diff < 60 * 60e3) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 24 * 60 * 60e3) return `${Math.floor(diff / 3.6e6)} 小时前`;
  return new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function renderSessionStats() {
  const el = document.getElementById('ai-session');
  if (!el) return;
  const json = JSON.stringify(sessions);
  if (json === lastStatsJson) return; // 内容无变化不重画
  lastStatsJson = json;

  if (sessions.length === 0) {
    el.innerHTML = '<div class="ai-session-empty">暂无会话数据</div>';
    return;
  }
  el.innerHTML = sessions.map((s, i) => `
    <div class="ai-session-card ${i === 0 ? 'active' : ''}">
      <div class="ai-session-head">
        <span class="ai-session-title" title="${escapeAttr(s.id)}">${escapeHtml(s.project || '未知项目')}</span>
        <span class="ai-session-app">${escapeHtml(s.app === 'codex' ? 'ChatGPT' : 'Claude')}</span>
        <span class="ai-session-model">${escapeHtml(s.model || '未知模型')}</span>
      </div>
      <div class="ai-session-grid">
        <div class="ai-session-cell">
          <span class="ai-session-num">${fmtTokens((s.sumIn || 0) + (s.sumCacheRead || 0))}</span>
          <span class="ai-session-label">输入</span>
        </div>
        <div class="ai-session-cell">
          <span class="ai-session-num">${fmtTokens(s.sumOut)}</span>
          <span class="ai-session-label">输出</span>
        </div>
        <div class="ai-session-cell">
          <span class="ai-session-num">${typeof s.turns === 'number' ? s.turns : '--'}</span>
          <span class="ai-session-label">轮次</span>
        </div>
      </div>
      <div class="ai-session-foot">
        <span class="ai-session-last">${fmtLastRequest(s.lastTs)}</span>
        <span class="ai-session-id">${escapeHtml((s.id || '').slice(0, 8))}</span>
      </div>
    </div>
  `).join('');
}

function appName(id) {
  const a = apps.find(x => x.id === id);
  return a ? a.name : id;
}

// ---- 交互（事件委托，渲染后不用重挂） ----
document.addEventListener('click', (e) => {
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
