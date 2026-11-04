// aimanager.js — 右侧 AI 控制台（本机应用 + 网页 AI 合并监看）
// 依赖本地伴侣程序 ai_manager_host（Native Messaging，需先 install-host.bat 安装）。
// 数据链路：本页 --runtime.connect--> SW --connectNative--> host；
// host 推送 apps / message / dialog / session 事件经 SW 广播回本页。
// 网页 AI 由 content-webai.js 上报，SW 按站点聚合后广播 webai 事件。
// UI：统一列表 + 实时概览 + 最近会话统计；不再把「本机 / 网页」拆成两套列表。

import { filterAiItems } from './ai-filter.js';

// 官方品牌图标（simple-icons 单路径 SVG，currentColor 填充随主题变色）
const APP_ICONS = {
  'claude-code': 'img/apps/claude.svg',
  codex: 'img/apps/chatgpt.svg',
  dsh: 'img/apps/deepseek.svg',
  ollama: 'img/apps/ollama.svg',
  lmstudio: 'img/apps/lmstudio.svg',
  'claude-desktop': 'img/apps/claude-desktop.svg',
  cursor: 'img/apps/cursor.svg',
  llamacpp: 'img/apps/local.svg',
  vllm: 'img/apps/local.svg',
  localai: 'img/apps/local.svg',
  koboldcpp: 'img/apps/local.svg',
  gpt4all: 'img/apps/local.svg',
  jan: 'img/apps/local.svg',
  'cherry-studio': 'img/apps/local.svg',
  chatbox: 'img/apps/local.svg',
  anythingllm: 'img/apps/local.svg',
  textgen: 'img/apps/local.svg',
};

const STATUS_LABELS = {
  tasking: '生成中',
  online: '在线',
  done: '已完成',
  offline: '离线',
};

// 图标 HTML：SVG 经 <img> 加载无法继承 currentColor（外链 SVG 是独立文档），
// 这里用 mask 让 SVG 当形状用，background 色随 .ai-app-icon 的 color 变化。
function appIconHtml(id) {
  const src = APP_ICONS[id];
  if (!src) return '<span class="ai-app-icon-fallback">·</span>';
  return `<span class="ai-app-icon" style="-webkit-mask-image:url('${src}');mask-image:url('${src}')"></span>`;
}

let port = null;           // 到 SW 的订阅连接
let apps = [];             // 本机 [{id,name,status,detail}]
let webApps = [];          // 网页 [{id,name,status,detail,active,tabId,color,short,title,lastTs}]
let sessions = [];         // [{app,id,project,model,sumIn,sumCacheRead,sumOut,turns,lastTs}]
let tasks = { active: [], recent: [] }; // host 的实时任务生命周期
const dialogs = new Map(); // id → dialog 对象
const expandedHistory = new Set();
let historySort = 'time';
// 本机应用状态以 host 的 apps.status 为唯一事实来源；页面不再维护“收到过 assistant 就 tasking”的状态机，
// 否则历史快照或丢失的完成事件会制造幽灵“生成中”。
const localActivity = new Map(); // app → 最近一次实时消息时间（本机应用列表的时间标签）
let filter = 'all';             // all | local | web
let showOffline = false;
let lastUpdated = 0;
let lastUnifiedSig = '';
let lastTaskSig = '';
let lastHistorySig = '';
let lastDialogSig = '';
let lastStatusKey = '';

export function initAiManager() {
  const panel = document.getElementById('ai-panel');
  if (!panel) return;
  // body.ai-panel-on 由 main.js 的布局逻辑统一管理（停靠/抽屉）
  render();
  connect();         // 常驻面板：加载即连接
  // 相对时间与“最后更新”要持续刷新；不重画整棵列表，只改文本节点。
  setInterval(() => {
    updateRealtimeLabels();
    updateTaskClocks();
    renderSummary();
  }, 5000);
  // 实时任务卡片的耗时用页面时钟走秒；不依赖 host 每秒发消息。
  setInterval(updateTaskClocks, 1000);
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
  lastUpdated = Date.now();
  switch (ev.type) {
    case 'snapshot':
      reconnectDelay = 1000; // 收到数据说明链路健康，重置退避
      apps = ev.apps || [];
      dialogs.clear();
      for (const d of (ev.dialogs || [])) dialogs.set(d.id, d);
      // 快照消息只用于最近活动时间；不参与 tasking 判定。
      // 旧消息没有 ts 时忽略，绝不能把“打开页面”当成“刚开始生成”。
      for (const m of (ev.messages || [])) {
        const t = parseTs(m.ts);
        if (m.app && t) localActivity.set(m.app, t);
      }
      sessions = ev.sessions || sessions;
      tasks = ev.tasks || tasks;
      hideBanner();
      break;
    case 'tasks':
      tasks = { active: ev.active || [], recent: ev.recent || [] };
      break;
    case 'apps':
      apps = ev.apps || apps;
      break;
    case 'webai':
      webApps = ev.apps || [];
      break;
    case 'message':
      if (ev.app) localActivity.set(ev.app, parseTs(ev.ts) || Date.now());
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
      render();
      return;
    case 'host:ready':
      hideBanner();
      break;
    default:
      return;
  }
  render();
}

// ---- 统一数据模型 ----
// 本机应用和网页 AI 都映射成同一形状的 item，排序时一起比较：
// 生成中 > 在线/已完成 > 离线；同状态优先当前标签页，再按最近活动。
// 本机 tasking 只由 host 的实时日志 adapter 判定，页面不再自行猜测。
function localStatus(app) {
  if (app.status === 'tasking') return 'tasking';
  if (app.status === 'online' || app.status === 'done') return 'online';
  return 'offline';
}

function latestSessionTs(appId) {
  let newest = 0;
  for (const s of sessions) {
    if (s.app !== appId) continue;
    const t = parseTs(s.lastTs);
    if (t > newest) newest = t;
  }
  return newest;
}

function buildItems() {
  const items = apps.map(a => {
    const status = localStatus(a);
    return {
      key: `local:${a.id}`,
      source: 'local',
      sourceLabel: '本机',
      name: a.name,
      detail: a.detail || '',
      status,
      active: false,
      appId: a.id,
      webTab: null,
      color: '',
      short: '',
      lastTs: localActivity.get(a.id) || latestSessionTs(a.id),
    };
  });

  for (const w of webApps) {
    const status = w.status === 'tasking' ? 'tasking' : 'online';
    items.push({
      key: `web:${w.id}:${w.tabId}`,
      source: 'web',
      sourceLabel: '网页',
      name: w.name,
      detail: w.detail || w.title || '网页会话',
      status,
      active: !!w.active,
      appId: w.id,
      webTab: w.tabId,
      color: safeColor(w.color),
      short: w.short || 'AI',
      lastTs: parseTs(w.lastActivity || w.lastTs),
    });
  }

  return items.sort((a, b) => {
    const rank = { tasking: 0, online: 1, done: 1, offline: 2 };
    return (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
      || Number(b.active) - Number(a.active)
      || b.lastTs - a.lastTs
      || a.name.localeCompare(b.name);
  });
}

function itemsForCurrentFilter(items) {
  return filterAiItems(items, filter, showOffline);
}

function statusText(items) {
  if (items.some(i => i.status === 'tasking')) return '生成中';
  if (items.some(i => i.status === 'online' || i.status === 'done')) return '在线';
  return '空闲';
}

function statusClassOf(items) {
  if (items.some(i => i.status === 'tasking')) return 'tasking';
  if (items.some(i => i.status === 'online' || i.status === 'done')) return 'online';
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
function render() {
  const list = document.getElementById('ai-unified-list');
  if (!list) return;
  const items = buildItems();
  renderHead(items);
  renderSummary(items);
  renderUnified(items);
  renderDialogs();
  renderLiveTasks();
  renderTaskHistory();
  updateRealtimeLabels();
  updateTaskClocks();
}

function renderHead(items) {
  const text = statusText(items);
  const cls = statusClassOf(items);
  const localOnline = items.filter(i => i.source === 'local' && i.status !== 'offline').length;
  const key = `${text}|${cls}|${localOnline}|${webApps.length}`;
  if (key === lastStatusKey) return;
  lastStatusKey = key;
  const status = document.getElementById('ai-status');
  if (status) {
    status.textContent = text;
    status.className = 'ai-status ' + cls;
  }
  const sub = document.getElementById('ai-live-sub');
  if (sub) sub.textContent = `本机 ${localOnline} · 网页 ${webApps.length} · 实时监看`;
}

function renderSummary(items = buildItems()) {
  const setNum = (id, value) => {
    const el = document.getElementById(id);
    if (el) el.textContent = String(value);
  };
  setNum('ai-sum-tasking', items.filter(i => i.status === 'tasking').length);
  setNum('ai-sum-online', items.filter(i => i.status !== 'offline').length);
  setNum('ai-sum-web', webApps.length);
}

function relTime(ts) {
  const t = parseTs(ts);
  if (!t) return '--';
  const diff = Math.max(0, Date.now() - t);
  if (diff < 10e3) return '刚刚';
  if (diff < 60e3) return `${Math.floor(diff / 1e3)} 秒前`;
  if (diff < 3.6e6) return `${Math.floor(diff / 60e3)} 分钟前`;
  if (diff < 86.4e6) return `${Math.floor(diff / 3.6e6)} 小时前`;
  return new Date(t).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' });
}

function parseTs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (!value) return 0;
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

function updateRealtimeLabels() {
  for (const el of document.querySelectorAll('[data-rel]')) {
    el.textContent = relTime(Number(el.dataset.rel) || 0);
  }
  const updated = document.getElementById('ai-updated');
  if (updated && lastUpdated) updated.textContent = `${relTime(lastUpdated)}更新`;
}

function renderUnified(items = buildItems()) {
  const list = document.getElementById('ai-unified-list');
  if (!list) return;
  const visible = itemsForCurrentFilter(items);
  const offlineCount = items.filter(i => i.source === 'local' && i.status === 'offline').length;

  // 只有数据/筛选变化才重画 DOM；心跳只刷新相对时间，避免列表闪烁。
  const sig = JSON.stringify({
    filter,
    showOffline,
    rows: visible.map(i => [i.key, i.status, i.detail, i.active]),
  });
  if (sig !== lastUnifiedSig) {
    lastUnifiedSig = sig;
    if (visible.length === 0) {
      const hint = filter === 'web'
        ? '打开 ChatGPT / Claude / Gemini 等网页后自动出现'
        : filter === 'local'
          ? '没有在线本机应用；启动 Ollama / Claude Code / LM Studio 等后出现'
          : '当前没有活跃 AI；打开网页 AI 或启动本机应用';
      list.innerHTML = `<div class="ai-empty">${hint}</div>`;
    } else {
      list.innerHTML = visible.map(itemHtml).join('');
    }
  }

  const toggle = document.getElementById('ai-offline-toggle');
  if (toggle) {
    const canToggle = filter !== 'web' && offlineCount > 0;
    toggle.classList.toggle('hidden', !canToggle);
    toggle.textContent = showOffline ? `收起 ${offlineCount} 个离线应用` : `显示 ${offlineCount} 个离线应用`;
    toggle.setAttribute('aria-expanded', String(showOffline));
  }

  // 心跳/消息只改时间文本，不重画列表；这里把新的 lastTs 同步到已有节点。
  const byKey = new Map(visible.map(i => [i.key, i]));
  for (const node of list.querySelectorAll('.ai-item')) {
    const item = byKey.get(node.dataset.aiKey);
    const time = node.querySelector('.ai-item-time');
    if (item && time) {
      time.dataset.rel = String(item.lastTs || 0);
      time.textContent = relTime(item.lastTs);
    }
  }

  for (const btn of document.querySelectorAll('.ai-filter')) {
    const active = btn.dataset.aiFilter === filter;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  }
}

function itemHtml(item) {
  const isWeb = item.source === 'web';
  const avatar = isWeb
    ? `<span class="ai-avatar" style="--avatar-color:${item.color}">${escapeHtml(item.short)}</span>`
    : `<span class="ai-avatar ai-avatar-local">${appIconHtml(item.appId)}</span>`;
  const activeTag = isWeb && item.active ? '<span class="ai-item-active-tag">当前</span>' : '';
  const title = `${item.name}${item.detail ? ' · ' + item.detail : ''}`;
  return `
    <div class="ai-item ai-item-${item.source} ${item.status}${item.active ? ' active' : ''}"
         data-ai-key="${escapeAttr(item.key)}"
         ${isWeb ? `role="button" tabindex="0" data-web-tab="${Number(item.webTab)}"` : 'role="listitem"'}
         title="${escapeAttr(title)}">
      ${avatar}
      <span class="ai-item-main">
        <span class="ai-item-top">
          <span class="ai-item-name">${escapeHtml(item.name)}</span>
          <span class="ai-item-source ${isWeb ? 'web' : ''}">${item.sourceLabel}</span>
          ${activeTag}
        </span>
        <span class="ai-item-detail">${escapeHtml(item.detail)}</span>
        <span class="ai-item-meta">
          <span class="ai-state-dot"></span>
          <span class="ai-item-status">${STATUS_LABELS[item.status] || item.status}</span>
          <span class="ai-item-time" data-rel="${item.lastTs || 0}">${relTime(item.lastTs)}</span>
        </span>
      </span>
    </div>
  `;
}

function renderDialogs() {
  const el = document.getElementById('ai-dialog-list');
  if (!el) return;
  const sig = JSON.stringify([...dialogs.values()].map(d => [d.id, d.app, d.title, d.buttons]));
  if (sig === lastDialogSig) return;
  lastDialogSig = sig;
  el.innerHTML = dialogs.size === 0
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

// ---- 实时任务 / 最近完成 ----
const PHASE_LABELS = {
  waiting_first_token: '等待响应',
  thinking: '思考中',
  streaming: '输出中',
  tool_running: '执行工具',
  waiting_user: '等待确认',
  done: '已完成',
  failed: '失败',
  ended: '已结束',
};

const OUTCOME_LABELS = {
  completed: '完成',
  failed: '失败',
  ended: '已结束',
  superseded: '被新任务替代',
  session: '会话记录',
};

const BLOCK_LABELS = {
  waiting_user: '等待你确认',
  tool_slow: '工具执行较慢',
  tool_blocked: '工具可能卡住',
  first_token_slow: '等待模型首 token',
  no_output: '长时间没有新输出',
};

function fmtTokens(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return '--';
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function fmtDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '--';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m${String(sec % 60).padStart(2, '0')}s`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}m`;
}

function taskPhaseLabel(task) {
  if (task.blocked && BLOCK_LABELS[task.blocked.kind]) return BLOCK_LABELS[task.blocked.kind];
  return PHASE_LABELS[task.phase] || task.phase || '运行中';
}

function taskTurnTotal(turn) {
  return (turn?.input || 0) + (turn?.cacheRead || 0) + (turn?.output || 0);
}

function taskTotal(turn) {
  return (turn?.input || 0) + (turn?.cacheRead || 0) + (turn?.output || 0);
}

function taskContextText(task) {
  const windowSize = Number(task.turn?.contextWindow || 0);
  const used = Number(task.turn?.contextTokens || 0);
  if (!windowSize || !used) return '';
  return `${Math.min(99, Math.round(used / windowSize * 100))}%`;
}

function taskDialog(task) {
  for (const d of dialogs.values()) {
    const p = String(d.app || '').toLowerCase();
    if (task.app === 'claude-code' && /claude/.test(p)) return d;
    if (task.app === 'codex' && /chatgpt|codex/.test(p)) return d;
  }
  return null;
}

function taskActionHtml(task) {
  if (task.action) {
    const name = escapeHtml(task.action.name || '工具');
    const target = task.action.target ? ` · <span class="ai-task-target">${escapeHtml(task.action.target)}</span>` : '';
    const status = task.action.status === 'running' ? '执行中' : (task.action.status === 'error' ? '出错' : '已返回');
    return `<span class="ai-task-tool">${name}</span>${target}<span class="ai-task-tool-status ${task.action.status}">${status}</span>`;
  }
  if (task.phase === 'streaming') return '<span class="ai-task-muted">正在生成回复…</span>';
  if (task.phase === 'waiting_first_token') return '<span class="ai-task-muted">等待模型返回第一个 token…</span>';
  if (task.phase === 'thinking') return '<span class="ai-task-muted">模型正在思考…</span>';
  return `<span class="ai-task-muted">${escapeHtml(taskPhaseLabel(task))}</span>`;
}

function renderLiveTasks() {
  const el = document.getElementById('ai-live-tasks');
  if (!el) return;
  const count = document.getElementById('ai-live-count');
  const active = (tasks.active || []).slice().sort((a, b) => {
    const rank = v => (v?.blocked?.severity === 'action' ? 0 : v?.blocked?.severity === 'danger' ? 1 : v?.blocked ? 2 : 3);
    return rank(a) - rank(b) || (a.startedAt || 0) - (b.startedAt || 0);
  });
  if (count) count.textContent = active.length ? `${active.length} 个` : '';
  const sig = JSON.stringify(active.map(t => [
    t.key, t.phase, t.model, t.action, t.blocked, t.turn, t.total, t.startedAt, t.phaseSince, t.lastEventAt,
    taskDialog(t)?.id,
  ]));
  if (sig === lastTaskSig) return;
  lastTaskSig = sig;
  if (!active.length) {
    el.innerHTML = '<div class="ai-task-empty">当前没有正在执行的任务</div>';
    return;
  }
  el.innerHTML = active.map(task => {
    const dlg = taskDialog(task);
    const blockedClass = task.blocked ? ` blocked ${escapeAttr(task.blocked.severity || 'warn')}` : '';
    const title = `${appName(task.app)}${task.project ? ' · ' + task.project : ''}`;
    const buttons = dlg && dlg.buttons && dlg.buttons.length
      ? `<div class="ai-task-actions">${dlg.buttons.map(b => `<button class="ai-dialog-btn ai-task-confirm" data-dlg="${dlg.id}" data-btn="${escapeAttr(b.id)}">${escapeHtml(b.label)}</button>`).join('')}</div>`
      : '';
    const context = taskContextText(task);
    return `
      <article class="ai-task${blockedClass}" data-task-key="${escapeAttr(task.key)}" title="${escapeAttr(title)}">
        <div class="ai-task-top">
          <span class="ai-task-app">${appIconHtml(task.app)}<span>${escapeHtml(appName(task.app))}</span></span>
          <span class="ai-task-project">${escapeHtml(task.project || '未知项目')}</span>
          <span class="ai-task-phase ${task.blocked ? 'is-blocked' : ''}">${escapeHtml(taskPhaseLabel(task))}</span>
          <span class="ai-task-clock" data-start="${task.startedAt || 0}">${fmtDuration(task.elapsedMs || 0)}</span>
        </div>
        <div class="ai-task-action">${taskActionHtml(task)}</div>
        ${task.blocked ? `
          <div class="ai-task-alert">
            <span>${escapeHtml(task.blocked.label || BLOCK_LABELS[task.blocked.kind] || '需要关注')}</span>
            <span class="ai-task-block-clock" data-since="${task.blocked.since || task.phaseSince || 0}">已 ${fmtDuration(Date.now() - (task.blocked.since || task.phaseSince || Date.now()))}</span>
          </div>` : ''}
        <div class="ai-task-meta">
          <span><b>本轮</b> ${fmtTokens((task.turn?.input || 0) + (task.turn?.cacheRead || 0))} in / ${fmtTokens(task.turn?.output || 0)} out</span>
          <span><b>累计</b> ${fmtTokens(taskTotal(task.total))} token</span>
          ${context ? `<span><b>上下文</b> ${context}</span>` : ''}
          <span class="ai-task-phase-clock" data-since="${task.phaseSince || 0}">${fmtDuration(task.phaseMs || 0)}</span>
        </div>
        <div class="ai-task-foot">
          <span>最近活动 <b data-rel="${task.lastEventAt || 0}">${relTime(task.lastEventAt)}</b></span>
          <span>${escapeHtml(task.model || task.id || '')}</span>
          ${buttons}
        </div>
      </article>
    `;
  }).join('');
}

function updateTaskClocks() {
  const now = Date.now();
  for (const el of document.querySelectorAll('.ai-task-clock[data-start]')) {
    const start = Number(el.dataset.start) || 0;
    if (start) el.textContent = fmtDuration(now - start);
  }
  for (const el of document.querySelectorAll('.ai-task-phase-clock[data-since]')) {
    const since = Number(el.dataset.since) || 0;
    if (since) el.textContent = `阶段 ${fmtDuration(now - since)}`;
  }
  for (const el of document.querySelectorAll('.ai-task-block-clock[data-since]')) {
    const since = Number(el.dataset.since) || 0;
    if (since) el.textContent = `已 ${fmtDuration(now - since)}`;
  }
}

function fallbackHistoryEntries() {
  const entries = (tasks.recent || []).map(t => ({ ...t, _kind: 'task', historyKey: t.historyKey || `${t.key}#${t.startedAt || 0}` }));
  const known = new Set(entries.map(e => `${e.app}:${e.id}`));
  for (const s of sessions) {
    if (!s.id || known.has(`${s.app}:${s.id}`)) continue;
    const ts = parseTs(s.lastTs);
    entries.push({
      key: `session:${s.app}:${s.id}`,
      historyKey: `session:${s.app}:${s.id}`,
      _kind: 'session',
      app: s.app, id: s.id, project: s.project || '', model: s.model || '',
      done: true, outcome: 'session', durationMs: null, startedAt: ts, completedAt: ts,
      lastEventAt: ts, action: null, blocked: null,
      turn: { input: s.sumIn || 0, cacheRead: s.sumCacheRead || 0, output: s.sumOut || 0 },
      total: { input: s.sumIn || 0, cacheRead: s.sumCacheRead || 0, output: s.sumOut || 0 },
    });
  }
  return entries;
}

function historyTime(entry) {
  return entry.completedAt || entry.lastEventAt || entry.startedAt || 0;
}

function historyRowHtml(entry, open) {
  const isSession = entry._kind === 'session';
  const outcome = entry.outcome || 'completed';
  const ok = outcome === 'completed' || isSession;
  const time = historyTime(entry);
  const tokenTotal = taskTurnTotal(entry.turn) || taskTotal(entry.total);
  const duration = entry.durationMs == null ? '--' : fmtDuration(entry.durationMs);
  const rowKey = entry.historyKey || entry.key;
  return `
    <div class="ai-history-row${open ? ' open' : ''}${ok ? '' : ' failed'}" data-history-key="${escapeAttr(rowKey)}">
      <button class="ai-history-toggle" type="button" data-history-toggle="${escapeAttr(rowKey)}" aria-expanded="${open}">
        <span class="ai-history-outcome ${ok ? 'ok' : 'bad'}">${isSession ? '·' : (ok ? '✓' : '!')}</span>
        <span class="ai-history-project" title="${escapeAttr(entry.project || entry.id || '')}">${escapeHtml(entry.project || '未知项目')}</span>
        <span class="ai-history-app">${escapeHtml(appName(entry.app))}</span>
        <span class="ai-history-duration">${duration}</span>
        <span class="ai-history-tokens" title="输入 ${(entry.turn?.input || 0) + (entry.turn?.cacheRead || 0)} / 输出 ${entry.turn?.output || 0}">${fmtTokens(tokenTotal)}</span>
        <span class="ai-history-time" data-rel="${time}">${relTime(time)}</span>
        <span class="ai-history-chevron" aria-hidden="true">${open ? '▾' : '▸'}</span>
      </button>
      ${open ? `
        <div class="ai-history-detail">
          <div class="ai-history-detail-row"><span>结果</span><b>${escapeHtml(OUTCOME_LABELS[outcome] || outcome)}</b></div>
          <div class="ai-history-detail-row"><span>模型</span><b>${escapeHtml(entry.model || '未知模型')}</b></div>
          <div class="ai-history-detail-row"><span>本轮 Token</span><b>${fmtTokens(entry.turn?.input || 0)} in / ${fmtTokens(entry.turn?.cacheRead || 0)} cache / ${fmtTokens(entry.turn?.output || 0)} out</b></div>
          <div class="ai-history-detail-row"><span>累计 Token</span><b>${fmtTokens(taskTotal(entry.total))} token</b></div>
          ${entry.action ? `<div class="ai-history-detail-row"><span>最后动作</span><b>${escapeHtml(entry.action.name || '')}${entry.action.target ? ' · ' + escapeHtml(entry.action.target) : ''}</b></div>` : ''}
          <div class="ai-history-detail-row"><span>会话 ID</span><b>${escapeHtml((entry.id || '').slice(0, 18) || '--')}</b></div>
          <div class="ai-history-detail-actions">
            <span>${isSession ? '最近' : '开始'} ${escapeHtml(entry.startedAt ? new Date(entry.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--')}</span>
            ${entry.id ? `<button type="button" class="ai-history-id" data-copy="${escapeAttr(entry.id)}">复制完整 ID</button>` : ''}
          </div>
        </div>` : ''}
    </div>`;
}

function renderTaskHistory(force = false) {
  const el = document.getElementById('ai-task-history');
  if (!el) return;
  const entries = fallbackHistoryEntries().sort((a, b) => {
    if (historySort === 'duration') return (b.durationMs || -1) - (a.durationMs || -1) || historyTime(b) - historyTime(a);
    if (historySort === 'tokens') return (taskTurnTotal(b.turn) || taskTotal(b.total)) - (taskTurnTotal(a.turn) || taskTotal(a.total)) || historyTime(b) - historyTime(a);
    if (historySort === 'project') return String(a.project || '').localeCompare(String(b.project || ''), 'zh-CN') || historyTime(b) - historyTime(a);
    return historyTime(b) - historyTime(a);
  }).slice(0, 12);
  const count = document.getElementById('ai-session-count');
  if (count) count.textContent = entries.length ? `${entries.length} 个` : '';
  const sig = JSON.stringify({
    sort: historySort,
    open: [...expandedHistory],
    entries: entries.map(e => [e.historyKey || e.key, e.project, e.model, e.outcome, e.durationMs, e.turn, e.id, e.action]),
  });
  if (!force && sig === lastHistorySig) return;
  lastHistorySig = sig;
  if (!entries.length) {
    el.innerHTML = '<div class="ai-task-history-empty">暂无完成任务；任务结束或会话有记录后会出现在这里</div>';
    return;
  }
  el.innerHTML = entries.map(e => historyRowHtml(e, expandedHistory.has(e.historyKey || e.key))).join('');
}

function renderSessionStats() {
  // 兼容旧调用；实际由 renderTaskHistory 渲染。
  renderTaskHistory();
}

async function copyText(text) {
  if (!text) return false;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

function appName(id) {
  const a = apps.find(x => x.id === id);
  return a ? a.name : id;
}

// ---- 交互（事件委托，渲染后不用重挂） ----
document.addEventListener('click', async (e) => {
  // 筛选：全部 / 本机 / 网页
  const filterBtn = e.target.closest('.ai-filter');
  if (filterBtn) {
    filter = filterBtn.dataset.aiFilter || 'all';
    lastUnifiedSig = '';
    renderUnified();
    return;
  }
  // 离线应用展开/收起
  if (e.target.closest('#ai-offline-toggle')) {
    showOffline = !showOffline;
    lastUnifiedSig = '';
    renderUnified();
    return;
  }
  // 网页 AI 卡片 → 切到对应标签页
  const webCard = e.target.closest('.ai-item-web');
  if (webCard) {
    const tabId = Number(webCard.dataset.webTab);
    if (Number.isInteger(tabId)) {
      chrome.runtime.sendMessage({ action: 'ai:web-focus', payload: { tabId } }, () => {
        void chrome.runtime.lastError;
      });
    }
    return;
  }
  // 最近完成：点击整行展开/收起
  const historyToggle = e.target.closest('[data-history-toggle]');
  if (historyToggle) {
    const key = historyToggle.dataset.historyToggle;
    if (expandedHistory.has(key)) expandedHistory.delete(key);
    else expandedHistory.add(key);
    renderTaskHistory(true);
    return;
  }
  // 历史短 ID → 复制完整 ID
  const idBtn = e.target.closest('.ai-session-id, .ai-history-id');
  if (idBtn) {
    e.stopPropagation();
    const ok = await copyText(idBtn.dataset.copy);
    const prev = idBtn.textContent;
    idBtn.textContent = ok ? '已复制' : '复制失败';
    idBtn.classList.add('copied');
    setTimeout(() => {
      idBtn.textContent = prev;
      idBtn.classList.remove('copied');
    }, 1200);
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
  if (e.target.closest('#ai-refresh')) {
    chrome.runtime.sendMessage({ action: 'ai:query' }, () => { void chrome.runtime.lastError; });
  }
});

document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'ai-history-sort') {
    historySort = e.target.value || 'time';
    renderTaskHistory(true);
  }
});

// 网页 AI 卡片支持键盘 Enter / Space 聚焦标签页
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const webCard = e.target.closest('.ai-item-web');
  if (!webCard) return;
  e.preventDefault();
  webCard.click();
});

function safeColor(value) {
  return /^#[0-9a-f]{3,8}$/i.test(String(value || '')) ? value : '#6b7280';
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
