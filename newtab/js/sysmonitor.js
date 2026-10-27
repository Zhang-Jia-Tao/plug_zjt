// sysmonitor.js — 左侧固定系统资源监视面板
// 数据源复用 AI 管理器的 host 链路（ai:subscribe → SW → connectNative），
// host 的 sysmon.ps1 轮询推送 {type:'sys', metrics:{...}} 经同一条通道广播。
// 可视化：CPU/内存/GPU/交换/磁盘 = 横向占比条 + 数值；温度 = 数值卡（不支持时显示「不支持」）。
// 历史迷你走势（sparkline）用纯 CSS 柱条，无图表库依赖。

const HISTORY_LEN = 40;        // 走势柱条数
// 注意：键集合必须与 METRICS 的 key 一致（漏一个会让 pushHistory 抛错，
// 阻断 renderValues，面板永远停在「--」骨架态——已在 swap 上踩过一次）
const history = { cpu: [], mem: [], gpu: [], swap: [], disk: [] };
let port = null;
let lastMetrics = null;
let lastUpdated = 0; // 最近一次收到 sys 事件的时间（呼吸点/摘要行用）

// 指标定义：key → {label, unit, 高压阈值(变红)}
const METRICS = [
  { key: 'cpu', label: 'CPU 占用', unit: '%', warn: 80 },
  { key: 'mem', label: '内存占用', unit: '%', warn: 90 },
  { key: 'gpu', label: 'GPU 占用', unit: '%', warn: 90 },
  { key: 'swap', label: '交换分区', unit: '%', warn: 60 },
  { key: 'disk', label: '磁盘活动', unit: '%', warn: 80 },
];

export function initSysMonitor() {
  const panel = document.getElementById('sys-panel');
  if (!panel) return;
  // body.sys-panel-on 由 main.js 的布局逻辑统一管理（停靠/抽屉）
  renderStatic();  // 先画骨架（等待数据态）
  connect();
  bindRefresh();
  bindVisibility();
  // 数据停滞指示：超过 12s 没收到 sys 事件把呼吸点变灰
  setInterval(() => {
    const dot = document.getElementById('sys-live');
    if (!dot) return;
    dot.classList.toggle('stale', !lastUpdated || Date.now() - lastUpdated > 12000);
    dot.title = lastUpdated
      ? `更新于 ${new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}`
      : '等待数据';
  }, 2000);
}

function bindRefresh() {
  const btn = document.getElementById('sys-refresh');
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.classList.remove('spinning');
    // 重新触发一次快照（host 收到 query 会补发 lastSys）
    void btn.offsetWidth;
    btn.classList.add('spinning');
    chrome.runtime.sendMessage({ action: 'ai:query' }, () => { void chrome.runtime.lastError; });
    setFast(!document.hidden);
    setTimeout(() => btn.classList.remove('spinning'), 800);
  });
}

// 页面切到后台时把 host 轮询降到 15s，回到前台恢复 3s，减少常驻 CPU
function bindVisibility() {
  document.addEventListener('visibilitychange', () => {
    setFast(!document.hidden);
    if (!document.hidden) {
      // 回到前台立即取一份最新快照，不必等下一轮 3s
      chrome.runtime.sendMessage({ action: 'ai:query' }, () => { void chrome.runtime.lastError; });
    }
  });
}

function setFast(fast) {
  chrome.runtime.sendMessage({ action: 'ai:sysmon', fast }, () => { void chrome.runtime.lastError; });
}

// ---- 连接（独立订阅口；断线指数退避重连） ----
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
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      connect();
    }, reconnectDelay);
  });
  // 告知 host：监视面板在线，sysmon 切 3s 高频；
  // 页面在后台时保持 15s 低频（host 侧对所有订阅者共享一份）
  setFast(!document.hidden);
}

function onEvent(ev) {
  if (!ev || ev.type !== 'sys') return;
  reconnectDelay = 1000; // 收到数据说明链路健康，重置退避
  lastMetrics = ev.metrics || {};
  lastUpdated = Date.now();
  try {
    pushHistory(lastMetrics);
    renderValues();
  } catch (e) {
    // 渲染异常不吞数据：lastMetrics 已存，下一轮 sys 事件会再试
    console.error('[sysmonitor] render error', e);
  }
}

// ---- 渲染 ----
// 骨架只画一次（renderStatic）；数值更新走 textContent/width 赋值，不重建 DOM
function renderStatic() {
  const list = document.getElementById('sys-metrics');
  if (!list) return;
  const rows = METRICS.map(m => `
    <div class="sys-row" id="sys-row-${m.key}">
      <div class="sys-row-head">
        <span class="sys-row-label">${m.label}</span>
        <span class="sys-row-val" id="sys-val-${m.key}">--</span>
      </div>
      <div class="sys-bar"><div class="sys-bar-fill" id="sys-fill-${m.key}"></div></div>
      <div class="sys-spark" id="sys-spark-${m.key}"></div>
    </div>
  `).join('');
  const temps = `
    <div class="sys-temps">
      <div class="sys-temp">
        <span class="sys-temp-label">CPU 温度</span>
        <span class="sys-temp-val" id="sys-cpu-temp">--</span>
      </div>
      <div class="sys-temp">
        <span class="sys-temp-label">GPU 温度</span>
        <span class="sys-temp-val" id="sys-gpu-temp">--</span>
      </div>
    </div>
    <div class="sys-sub" id="sys-sub"></div>
  `;
  list.innerHTML = rows + temps;
}

function renderValues() {
  const m = lastMetrics;
  if (!m) return;

  // 占比条 + 走势
  for (const def of METRICS) {
    const valEl = document.getElementById(`sys-val-${def.key}`);
    const fillEl = document.getElementById(`sys-fill-${def.key}`);
    if (!valEl || !fillEl) continue;
    const v = m[def.key];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      valEl.textContent = '不支持';
      valEl.classList.add('na');
      fillEl.style.width = '0%';
      fillEl.classList.remove('warn');
    } else {
      valEl.textContent = `${v.toFixed(0)}%`;
      valEl.classList.remove('na');
      fillEl.style.width = `${Math.min(v, 100)}%`;
      fillEl.classList.toggle('warn', v >= def.warn);
    }
    renderSpark(def.key);
  }

  // 温度
  setTemp('sys-cpu-temp', m.cpuTemp);
  setTemp('sys-gpu-temp', m.gpuTemp);

  // 摘要行：内存用量 / 交换用量 / 磁盘读写速率 / 开机时长
  const sub = document.getElementById('sys-sub');
  if (sub) {
    const parts = [];
    if (typeof m.memUsed === 'number' && typeof m.memTotal === 'number') {
      parts.push(`内存 ${m.memUsed.toFixed(1)}/${m.memTotal.toFixed(1)}GB`);
    }
    if (typeof m.swapUsed === 'number' && typeof m.swapTotal === 'number') {
      parts.push(`交换 ${m.swapUsed.toFixed(1)}/${m.swapTotal.toFixed(1)}GB`);
    }
    if (typeof m.vramUsed === 'number' && typeof m.vramTotal === 'number' && m.vramTotal > 0) {
      parts.push(`显存 ${m.vramUsed.toFixed(1)}/${m.vramTotal.toFixed(1)}GB`);
    }
    if (typeof m.diskRead === 'number') parts.push(`读 ${m.diskRead.toFixed(1)}MB/s`);
    if (typeof m.diskWrite === 'number') parts.push(`写 ${m.diskWrite.toFixed(1)}MB/s`);
    if (typeof m.uptime === 'number') parts.push(`开机 ${m.uptime.toFixed(0)}h`);
    if (lastUpdated) {
      parts.push(`更新 ${new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false })}`);
    }
    sub.textContent = parts.join(' · ');
  }
}

function setTemp(id, v) {
  const el = document.getElementById(id);
  if (!el) return;
  if (typeof v !== 'number' || Number.isNaN(v)) {
    el.textContent = '不支持';
    el.classList.add('na');
  } else {
    el.textContent = `${v.toFixed(0)}°C`;
    el.classList.remove('na');
    el.classList.toggle('warn', v >= 75);
  }
}

// 纯 CSS 柱状走势：历史值 → 高度百分比
function renderSpark(key) {
  const el = document.getElementById(`sys-spark-${key}`);
  if (!el) return;
  const hist = history[key];
  // 复用已有柱节点，只更新高度（不重建）
  const bars = el.children;
  if (bars.length !== HISTORY_LEN) {
    el.innerHTML = '<i></i>'.repeat(HISTORY_LEN);
  }
  for (let i = 0; i < HISTORY_LEN; i++) {
    // 历史从旧到新填充尾部；空段高度 0
    const idx = hist.length - HISTORY_LEN + i;
    const v = idx >= 0 ? hist[idx] : null;
    const bar = el.children[i];
    bar.style.height = v == null ? '0%' : `${Math.max(Math.min(v, 100), 2)}%`;
  }
}

function pushHistory(m) {
  for (const def of METRICS) {
    // 兜底：history 缺键时自动补数组（防御键集合不同步的问题）
    if (!Array.isArray(history[def.key])) history[def.key] = [];
    const v = m[def.key];
    const arr = history[def.key];
    arr.push(typeof v === 'number' ? v : 0);
    if (arr.length > HISTORY_LEN) arr.splice(0, arr.length - HISTORY_LEN);
  }
}
