// content.js — 注入到所有网页：左侧悬浮把手 + 展开目录树侧边栏（iframe 加载扩展 tree.html）
// 快捷键 Ctrl+Shift+E 也开关侧边栏（SW 转发 content:toggle-tree 消息过来）。

(() => {
  if (window.__newtabTreeInjected) return; // 防 fragment 型页面二次注入
  window.__newtabTreeInjected = true;

  const EXT_URL = chrome.runtime.getURL('tree.html');

  let handle = null;   // 悬浮把手
  let wrap = null;     // 侧边栏容器（含 iframe）
  let open = false;
  let collapsed = false; // 把手是否被用户拖到半隐藏

  // ---- 把手 ----
  function createHandle() {
    handle = document.createElement('div');
    handle.className = 'nt-tree-handle';
    handle.title = '本地目录树（Ctrl+Shift+E）';
    handle.innerHTML = '📁<span class="nt-tree-handle-label">目录</span>';
    document.documentElement.appendChild(handle);
    handle.addEventListener('click', toggleSidebar);
    // 位置持久化：拖动改 top（chrome.storage.session 简化为内存 + localStorage 兜底）
    const savedTop = localStorage.getItem('nt-tree-handle-top');
    if (savedTop) handle.style.top = savedTop;
    // 贴边自动半隐：鼠标离开 2s 后缩进
    handle.addEventListener('mouseenter', () => handle.classList.remove('docked'));
    handle.addEventListener('mouseleave', () => {
      setTimeout(() => handle.classList.add('docked'), 1500);
    });
    enableDrag();
  }

  // 轻量拖拽（纵向）
  function enableDrag() {
    let startY = 0, startTop = 0, dragging = false;
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      // 小位移视为点击，大幅移动才当拖拽（click 事件仍会触发，由位移阈值短路）
      dragging = true;
      startY = e.clientY;
      startTop = handle.getBoundingClientRect().top;
      handle.classList.add('dragging');
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 6) handle.dataset.moved = '1';
      const top = Math.max(8, Math.min(window.innerHeight - 60, startTop + dy));
      handle.style.top = `${top}px`;
    });
    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      handle.classList.remove('dragging');
      if (handle.dataset.moved) {
        localStorage.setItem('nt-tree-handle-top', handle.style.top);
        delete handle.dataset.moved;
      }
    });
    handle.addEventListener('click', (e) => {
      if (handle.dataset.moved) { e.stopImmediatePropagation(); delete handle.dataset.moved; }
    }, true); // capture，先于常规 click 监听
  }

  // ---- 侧边栏 ----
  function createSidebar() {
    wrap = document.createElement('div');
    wrap.className = 'nt-tree-wrap';
    wrap.innerHTML = `
      <div class="nt-tree-sidebar">
        <div class="nt-tree-grab"></div>
        <iframe src="${EXT_URL}" frameborder="0"></iframe>
        <button class="nt-tree-close" title="收起">‹</button>
      </div>
    `;
    document.documentElement.appendChild(wrap);
    wrap.querySelector('.nt-tree-close').addEventListener('click', () => toggleSidebar(false));
    // 抓手拖宽度
    const grab = wrap.querySelector('.nt-tree-grab');
    let dragging = false;
    grab.addEventListener('mousedown', (e) => {
      dragging = true;
      e.preventDefault();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const w = Math.max(240, Math.min(520, e.clientX));
      wrap.style.setProperty('--nt-tree-w', `${w}px`);
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    // 点击 iframe 外部不收起（iframe 会吃掉点击）；ESC 收起
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && open) toggleSidebar(false);
    });
  }

  function toggleSidebar(force) {
    if (!handle) createHandle();
    if (!wrap) createSidebar();
    open = typeof force === 'boolean' ? force : !open;
    wrap.classList.toggle('open', open);
    document.body.classList.toggle('nt-tree-open', open);
  }

  // SW 快捷键转发
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.action === 'content:toggle-tree') toggleSidebar();
  });

  // 页面就绪后挂把手
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', createHandle);
  } else {
    createHandle();
  }
})();
