// sysmonitor.js — 左侧固定系统资源监视面板
// 数据源复用 AI 管理器的 host 链路（ai:subscribe → SW → connectNative），
// host 的 sysmon.ps1 轮询推送 {type:'sys', metrics:{...}} 经同一条通道广播。
// 可视化：CPU 环形总览 + 指标卡（占比条/数值/迷你走势）；温度 = 数值卡。
// 历史走势用纯 CSS 柱条，无图表库依赖。

const HISTORY_LEN = 40;        // 走势柱条数
// 注意：键集合必须与 METRICS 的 key 一致（漏一个会让 pushHistory 抛错，
// 阻断 renderValues，面板永远停在「--」骨架态——已在 swap 上踩过一次）
const history = { cpu: [], mem: [], gpu: [], swap: [], disk: [] };
let port = null;
let lastMetrics = null;
let lastUpdated = 0; // 最近一次收到 sys 事件的时间（呼吸点/摘要行用）

// 指标定义：key → {label, unit, 高压阈值(变红), hint}
const METRICS = [
  { key: 'cpu', label: 'CPU 占用', unit: '%', warn: 80, hint: '处理器负载' },
  { key: 'mem', label: '内存占用', unit: '%', warn: 90, hint: '物理内存' },
  { key: 'gpu', label: 'GPU 占用', unit: '%', warn: 90, hint: '图形处理器' },
  { key: 'swap', label: '交换分区', unit: '%', warn: 60, hint: '页面文件' },
  { key: 'disk', label: '磁盘活动', unit: '%', warn: 80, hint: '读写占用' },
];

export function initSysMonitor() {
  const panel = document.getElementById('sys-panel');
  if (!panel) return;
  // body.sys-panel-on 由 main.js 的布局逻辑统一管理（停靠/抽屉）
  renderStatic();  // 先画骨架（等待数据态）
  connect();
  bindRefresh();
  bindVisibility();
  // 数据停滞指示：host 高频轮询为 5s，超过 20s 没收到 sys 事件才把呼吸点变灰
  setInterval(() => {
    const dot = document.getElementById('sys-live');
    if (!dot) return;
    dot.classList.toggle('stale', !lastUpdated || Date.now() - lastUpdated > 20000);
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

// 页面切到后台时把 host 轮询降到 15s，回到前台恢复 5s，减少常驻 CPU
function bindVisibility() {
  document.addEventListener('visibilitychange', () => {
    setFast(!document.hidden);
    if (!document.hidden) {
      // 回到前台立即取一份最新快照，不必等下一轮 5s
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
  // 告知 host：监视面板在线，sysmon 切 5s 高频；
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
    <div class="sys-card sys-row" id="sys-row-${m.key}" data-key="${m.key}">
      <div class="sys-card-head">
        <span class="sys-card-label"><i class="sys-card-dot"></i>${m.label}</span>
        <span class="sys-row-val" id="sys-val-${m.key}">--</span>
      </div>
      <div class="sys-bar"><div class="sys-bar-fill" id="sys-fill-${m.key}"></div></div>
      <div class="sys-card-foot">
        <span class="sys-card-hint">${m.hint}</span>
        <div class="sys-spark" id="sys-spark-${m.key}"></div>
      </div>
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
  `;
  list.innerHTML = `
    <div class="sys-hero">
      <div class="sys-gauge" id="sys-gauge" style="--pct:0">
        <div class="sys-gauge-inner">
          <span class="sys-gauge-val" id="sys-gauge-val">--</span>
          <span class="sys-gauge-unit">CPU</span>
        </div>
      </div>
      <div class="sys-hero-copy">
        <span class="sys-eyebrow">实时负载</span>
        <strong class="sys-hero-title" id="sys-hero-title">等待数据</strong>
        <span class="sys-hero-sub" id="sys-hero-sub">host 连接后自动刷新</span>
      </div>
    </div>
    <div class="sys-section"><span>实时指标</span><span class="sys-section-meta">5 项</span></div>
    <div class="sys-card-list">${rows}</div>
    <div class="sys-section"><span>温度</span><span class="sys-section-meta">硬件传感器</span></div>
    ${temps}
    <div class="sys-section"><span>运行信息</span><span class="sys-section-meta" id="sys-update-label">--</span></div>
    <div class="sys-sub" id="sys-sub"></div>
  `;
}

function renderValues() {
  const m = lastMetrics;
  if (!m) return;

  // 占比条 + 走势
  for (const def of METRICS) {
    const valEl = document.getElementById(`sys-val-${def.key}`);
    const fillEl = document.getElementById(`sys-fill-${def.key}`);
    const rowEl = document.getElementById(`sys-row-${def.key}`);
    if (!valEl || !fillEl) continue;
    const v = m[def.key];
    if (typeof v !== 'number' || Number.isNaN(v)) {
      valEl.textContent = '不支持';
      valEl.classList.add('na');
      fillEl.style.width = '0%';
      fillEl.classList.remove('warn');
      rowEl?.classList.remove('warn');
    } else {
      valEl.textContent = `${v.toFixed(0)}%`;
      valEl.classList.remove('na');
      fillEl.style.width = `${Math.min(v, 100)}%`;
      fillEl.classList.toggle('warn', v >= def.warn);
      rowEl?.classList.toggle('warn', v >= def.warn);
    }
    renderSpark(def.key);
  }

  // 温度
  setTemp('sys-cpu-temp', m.cpuTemp);
  setTemp('sys-gpu-temp', m.gpuTemp);

  // 顶部环形总览：用 CPU 作为主指标，配一句可读的负载结论
  const gauge = document.getElementById('sys-gauge');
  const gaugeVal = document.getElementById('sys-gauge-val');
  const heroTitle = document.getElementById('sys-hero-title');
  const heroSub = document.getElementById('sys-hero-sub');
  const cpu = m.cpu;
  if (typeof cpu === 'number' && !Number.isNaN(cpu)) {
    const pct = Math.max(0, Math.min(100, cpu));
    if (gauge) {
      gauge.style.setProperty('--pct', String(pct));
      gauge.classList.toggle('warn', pct >= 80);
      gauge.classList.remove('na');
    }
    if (gaugeVal) gaugeVal.textContent = `${pct.toFixed(0)}`;
    if (heroTitle) heroTitle.textContent = pct >= 80 ? '高负载' : pct >= 50 ? '中等负载' : '运行平稳';
    if (heroSub) {
      const bits = [];
      if (typeof m.memUsed === 'number' && typeof m.memTotal === 'number') {
        bits.push(`内存 ${m.memUsed.toFixed(1)} / ${m.memTotal.toFixed(0)} GB`);
      }
      bits.push(`磁盘 ${typeof m.disk === 'number' ? `${m.disk.toFixed(0)}%` : '--'}`);
      heroSub.textContent = bits.join(' · ');
    }
  } else {
    if (gauge) {
      gauge.style.setProperty('--pct', '0');
      gauge.classList.remove('warn');
      gauge.classList.add('na');
    }
    if (gaugeVal) gaugeVal.textContent = '--';
    if (heroTitle) heroTitle.textContent = '等待数据';
    if (heroSub) heroSub.textContent = 'host 连接后自动刷新';
  }

  // 运行信息：改为小卡片 chips，比一行挤在一起的长文本更易扫读
  const sub = document.getElementById('sys-sub');
  if (sub) {
    const chips = [];
    const chip = (label, value) => `<span class="sys-chip"><span>${label}</span><b>${value}</b></span>`;
    if (typeof m.memUsed === 'number' && typeof m.memTotal === 'number') {
      chips.push(chip('内存', `${m.memUsed.toFixed(1)} / ${m.memTotal.toFixed(0)} GB`));
    }
    if (typeof m.swapUsed === 'number' && typeof m.swapTotal === 'number') {
      chips.push(chip('交换', `${m.swapUsed.toFixed(1)} / ${m.swapTotal.toFixed(0)} GB`));
    }
    if (typeof m.vramUsed === 'number' && typeof m.vramTotal === 'number' && m.vramTotal > 0) {
      chips.push(chip('显存', `${m.vramUsed.toFixed(1)} / ${m.vramTotal.toFixed(0)} GB`));
    }
    if (typeof m.diskRead === 'number' || typeof m.diskWrite === 'number') {
      const r = typeof m.diskRead === 'number' ? m.diskRead.toFixed(1) : '--';
      const w = typeof m.diskWrite === 'number' ? m.diskWrite.toFixed(1) : '--';
      chips.push(chip('磁盘 I/O', `${r} / ${w} MB/s`));
    }
    if (typeof m.uptime === 'number') chips.push(chip('开机', `${m.uptime.toFixed(0)} h`));
    sub.innerHTML = chips.length ? chips.join('') : '<span class="sys-empty">等待运行信息</span>';
  }
  const updated = document.getElementById('sys-update-label');
  if (updated && lastUpdated) {
    updated.textContent = new Date(lastUpdated).toLocaleTimeString('zh-CN', { hour12: false });
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
