// content-webai.js — 网页端 AI 活动状态采集（隔离世界，不读取聊天内容）
// 只在 manifest 声明的 AI 域名运行；只上报 host/status/title/active，由 SW 聚合成应用卡片。
// 生成中判定优先使用各站点通用的 Stop 按钮 / aria-busy / streaming 标记；
// 找不到明确标记时保持 online，宁可少报「生成中」也不误报。
(() => {
  const STOP_SELECTORS = [
    '[data-testid="stop-button"]',
    '[data-testid*="stop"]',
    'button[aria-label*="stop" i]',
    'button[aria-label*="停止"]',
    'button[title*="stop" i]',
    'button[title*="停止"]',
    '[class*="stop-button"]',
    '[class*="stopButton"]',
  ];
  const STREAM_SELECTORS = [
    '[data-is-streaming="true"]',
    '[data-streaming="true"]',
    '[data-testid="streaming"]',
  ];
  const STOP_LABEL_RE = /(^|\s)(stop|stop generating|stop responding|stop response|stop streaming)(\s|$)|停止|中止生成/i;

  let observer = null;
  let scheduleTimer = null;
  let heartbeatTimer = null;
  let routeTimer = null;
  let lastKey = '';
  let lastHref = location.href;
  let lastFallbackScan = 0;
  // 主内容区新增节点/文本变化 = 会话在产出；只记录时间，不读取正文。
  let lastActivityAt = 0;
  // Stop/aria-busy 第一次出现的时刻。只有“出现之后仍有真实活动”才算生成中，
  // 防止站点常驻的 Stop 按钮把空闲页面误报成 tasking。
  let taskSignalAt = 0;
  let disposed = false;

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (el.closest('[aria-hidden="true"]')) return false;
    // checkVisibility 比 getComputedStyle 更轻；不支持时再退回样式判断。
    if (typeof el.checkVisibility === 'function') {
      try {
        if (!el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
      } catch { /* 个别浏览器不接受参数，走下面的兜底 */ }
    } else {
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  const COMPOSER_SCOPE = 'form, textarea, [contenteditable="true"], [role="textbox"], [data-testid*="composer" i], [class*="composer" i]';

  function isMainUi(node) {
    return isMainNode(node) || !!(node.closest && node.closest(COMPOSER_SCOPE));
  }

  function hasStopControl() {
    for (const selector of STOP_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      for (const node of nodes) {
        if (node.disabled || node.getAttribute('aria-disabled') === 'true') continue;
        // 只认主内容区/输入框附近的 Stop，避免侧栏、设置面板里的同名按钮误报。
        if (isMainUi(node) && isVisible(node)) return true;
      }
    }
    // 站点改版兜底：只在主内容区找，并限制频率。聊天页面按钮很多，
    // 每次 DOM 变化都全页扫描会持续触发布局读取，造成输入/滚动卡顿。
    const now = Date.now();
    if (now - lastFallbackScan < 1500) return false;
    lastFallbackScan = now;
    const scope = document.querySelector('main, [role="main"], #main') || document.body;
    const buttons = scope.querySelectorAll('button, [role="button"]');
    for (const btn of buttons) {
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
      const label = [
        btn.getAttribute('aria-label'),
        btn.getAttribute('title'),
        btn.textContent,
      ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, 100);
      if (label && STOP_LABEL_RE.test(label) && isMainUi(btn) && isVisible(btn)) return true;
    }
    return false;
  }

  function hasBusyMarker() {
    for (const selector of STREAM_SELECTORS) {
      let nodes;
      try { nodes = document.querySelectorAll(selector); } catch { continue; }
      for (const node of nodes) {
        if (isVisible(node)) return true;
      }
    }
    // aria-busy 只在主内容区判断，避免侧边栏加载器把状态误判成生成中
    const roots = document.querySelectorAll('main, [role="main"], #main');
    for (const root of roots) {
      if (root.getAttribute('aria-busy') === 'true' && isVisible(root)) return true;
      const busy = root.querySelector('[aria-busy="true"]');
      if (busy && isVisible(busy)) return true;
    }
    return false;
  }

  function readTitle() {
    const raw = String(document.title || '').replace(/\s+/g, ' ').trim();
    const m = raw.match(/^(.*?)\s*[-–—|·]\s*(ChatGPT|Claude|Gemini|DeepSeek|Kimi|Perplexity|Grok|Copilot)\b/i);
    const title = (m ? m[1] : raw).trim();
    return title.slice(0, 100);
  }

  function snapshot() {
    const signal = hasStopControl() || hasBusyMarker();
    const now = Date.now();
    if (!signal) taskSignalAt = 0;
    else if (!taskSignalAt) taskSignalAt = now;

    // 两个条件缺一不可：
    // 1) Stop/aria-busy 出现后，主内容区确实又有新增节点或文本变化；
    // 2) 这次活动发生在最近 4 秒。
    // 这样常驻 Stop 按钮、静态页面不会一直显示“生成中”；长思考但无任何输出时宁可显示在线。
    const freshActivity = lastActivityAt > taskSignalAt
      && now - lastActivityAt < 4000;
    const tasking = !!(signal && freshActivity);
    const recentActivity = lastActivityAt && now - lastActivityAt < 6000
      ? lastActivityAt
      : 0;
    return {
      host: location.hostname,
      status: tasking ? 'tasking' : 'online',
      title: readTitle(),
      active: document.visibilityState === 'visible',
      url: location.href.slice(0, 300),
      activityTs: recentActivity,
    };
  }

  function cleanup() {
    disposed = true;
    clearTimeout(scheduleTimer);
    clearInterval(heartbeatTimer);
    clearInterval(routeTimer);
    if (observer) observer.disconnect();
  }

  function send(force = false) {
    if (disposed) return;
    if (!chrome.runtime || !chrome.runtime.id) { cleanup(); return; }
    let state;
    try { state = snapshot(); } catch { return; }
    const key = [state.status, state.title, state.active, state.url].join('|');
    if (!force && key === lastKey) return;
    lastKey = key;
    try {
      chrome.runtime.sendMessage({ action: 'ai:web-state', payload: state }, () => {
        void chrome.runtime.lastError; // SW 重启/扩展重载时静默
      });
    } catch {
      cleanup();
    }
  }

  function schedule() {
    if (disposed || scheduleTimer) return;
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      send();
    }, 300);
  }

  function isMainNode(node) {
    const el = node && node.nodeType === 1 ? node : node && node.parentElement;
    return !!(el && el.closest && el.closest('main, [role="main"], #main'));
  }

  function start() {
    if (disposed) return;
    if (!document.body) {
      setTimeout(start, 200);
      return;
    }
    observer = new MutationObserver((mutations) => {
      // childList 覆盖“追加新段落”，characterData 覆盖“React 直接改已有文本节点”。
      // 两种都只更新时间戳，不读取 textContent/data；否则流式输出会读不到活动。
      for (const m of mutations) {
        if (isMainNode(m.target)
          && (m.type === 'childList' || m.type === 'characterData')) {
          lastActivityAt = Date.now();
          break;
        }
      }
      schedule();
    });
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true, // 只用于活动检测；回调不读取正文
      attributes: true,
      attributeFilter: ['aria-busy', 'aria-label', 'title', 'disabled'],
    });
    document.addEventListener('visibilitychange', () => send(true), true);
    document.addEventListener('click', schedule, true);
    document.addEventListener('keydown', schedule, true);
    window.addEventListener('pageshow', () => send(true));
    window.addEventListener('focus', () => send());
    // 标签页被激活时 SW 会主动 ping；比等 3~8s 心跳更快拿到当前状态。
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || msg.action !== 'ai:web-ping') return;
        send(true);
        sendResponse({ ok: true });
      });
    } catch { /* 扩展上下文失效时忽略 */ }
    heartbeatTimer = setInterval(() => send(true), 3500);
    routeTimer = setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      schedule();
    }, 1000);
    send(true);
  }

  start();
})();
