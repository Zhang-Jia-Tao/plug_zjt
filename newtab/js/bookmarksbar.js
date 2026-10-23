// bookmarksbar.js — 顶部书签栏（仿谷歌首页「收藏的网址」一行）
// chrome.bookmarks 读取书签栏（根 id '1'）：网址点击当前标签跳转（同谷歌快捷方式），
// 文件夹点击弹出面板逐层浏览（面板挂 body，fixed 定位不受裁剪）。
// 图标：优先请求站点真实 favicon（/favicon.ico），失败回退品牌色首字母磁贴
// （MV3 扩展页禁 inline 事件，onerror 必须用 addEventListener 挂）。
// 书签过多时末尾出现「»」下拉按钮，点开可见被挤出的其余书签。
// 书签增删改移时由 chrome.bookmarks 事件驱动自动刷新。

import { colorFor, letterFor } from './widgets/topSites.js';
import { placePopover } from './widgets/popover.js';
import { faviconImgHtml, wireFavicons as wireFavImgs } from './favicon.js';

let pop = null;        // 当前打开的文件夹面板（挂 body）
let popAnchor = null;  // 面板锚定的按钮（再点同一个 = 收起）
let barNodes = [];     // 书签栏当前渲染的顶层节点（溢出检测用）
let hiddenNodes = [];  // 被宽度挤掉、收进下拉面板的节点
let resizeTimer = null;
const navStack = [];   // 面板内逐层进入的文件夹栈 [{ id, name, nodes? }]

// 取某节点的直接子节点（书签栏 id 为 '1'）
function getChildren(id) {
  return new Promise((resolve) => {
    chrome.bookmarks.getChildren(id, (nodes) => {
      resolve(chrome.runtime.lastError ? [] : (nodes || []));
    });
  });
}

// 书签跳转：一律经 SW 的 tabs API。
// 原因：chrome:// 等内部页面普通网页无权导航（Not allowed to load local resource），
// 且当前页就是 newtab 时 update 自己也受限；SW 统一处理内部页/新标签页逻辑。
function navigateTo(url) {
  if (!/^https?:/i.test(url)) {
    // 内部地址兜底也走 SW；SW 不可用时至少不再往 location 塞 chrome:// 触发报错
    chrome.runtime.sendMessage({ action: 'bm:navigate', payload: { url } }, () => {
      void chrome.runtime.lastError;
    });
    return;
  }
  chrome.runtime.sendMessage({ action: 'bm:navigate', payload: { url } }, () => {
    void chrome.runtime.lastError;
    // SW 失败兜底：直接 location 跳（http/https 总是允许）
    try { window.location.href = url; } catch { /* 忽略 */ }
  });
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return ''; }
}

// Chrome 同款文件夹图标（SVG 矢量，非 emoji；颜色随主题 muted 变量）
const FOLDER_SVG = `<svg class="bm-folder-svg" viewBox="0 0 20 16" aria-hidden="true"><path fill="currentColor" d="M1.6 3.2c0-.9.7-1.6 1.6-1.6h4.3c.4 0 .8.2 1.1.5l1.2 1.4h7.1c.9 0 1.6.7 1.6 1.6v8.5c0 .9-.7 1.6-1.6 1.6H3.2c-.9 0-1.6-.7-1.6-1.6V3.2z"/></svg>`;

// 图标磁贴：底层字母磁贴 + 上层真实 favicon（加载成功后覆盖字母）。
// favicon 走 chrome://favicon2（Chrome 自带缓存，零网络请求）；无缓存的站点
// 回退字母磁贴。chrome:// 等内部地址不生成 img。
function iconHtml(url) {
  const host = hostOf(url);
  return `
    <span class="bm-icon fav-wrap" style="--tab-color:${colorFor(host)}">
      <span class="fav-letter">${escapeHtml(letterFor(host || '?'))}</span>
      ${faviconImgHtml(url)}
    </span>
  `;
}

// 给 scope 内所有 favicon 挂载成功/失败处理（成功 → 盖住字母；失败 → 移除 img）。
function wireFavicons(scope) {
  // 先清理历史遗留的旧结构 class（bm-favicon），再统一走公共逻辑
  for (const old of scope.querySelectorAll('.bm-favicon')) old.classList.add('fav-img');
  wireFavImgs(scope);
}

export function initBookmarkBar() {
  const bar = document.getElementById('bm-bar-list');
  renderBar(bar);
  // 书签增删改移 → 刷新栏
  for (const ev of ['onCreated', 'onRemoved', 'onChanged', 'onMoved', 'onChildrenReordered']) {
    if (chrome.bookmarks[ev]) chrome.bookmarks[ev].addListener(() => renderBar(bar));
  }
  bar.addEventListener('click', onBarClick);
  document.getElementById('bm-more').addEventListener('click', (e) => {
    e.stopPropagation();
    if (pop && popAnchor === e.currentTarget) { closePop(); return; }
    openPop(e.currentTarget, { id: '1', name: '更多书签', nodes: hiddenNodes });
  });
  // 点面板/书签栏外关闭面板
  document.addEventListener('click', (e) => {
    if (pop && !pop.contains(e.target) && !bar.contains(e.target)
      && !document.getElementById('bm-more').contains(e.target)) closePop();
  });
  // 窗口宽度变化 → 重新计算哪些书签被挤出
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => layoutBar(), 150);
  });
}

async function renderBar(bar) {
  barNodes = await getChildren('1');
  if (barNodes.length === 0) {
    bar.innerHTML = '<span class="bm-empty">⭐ 收藏的网址会显示在这里（Ctrl+D 添加书签）</span>';
    document.getElementById('bm-more').classList.add('hidden');
    return;
  }
  bar.innerHTML = barNodes.map(nodeHtml).join('');
  wireFavicons(bar);
  layoutBar();
}

// 单个顶层书签的按钮（data-bid 用于溢出检测时反查节点）
function nodeHtml(n) {
  if (n.url) {
    return `
      <button class="bm-item" data-bid="${n.id}" data-url="${escapeAttr(n.url)}" title="${escapeAttr(n.title || n.url)}">
        ${iconHtml(n.url)}
        <span class="bm-name">${escapeHtml(ellipsis(n.title || hostOf(n.url), 14))}</span>
      </button>
    `;
  }
  return `
    <button class="bm-item bm-folder" data-bid="${n.id}" data-id="${n.id}" title="${escapeAttr(n.title)}">
      <span class="bm-icon bm-folder-icon">${FOLDER_SVG}</span>
      <span class="bm-name">${escapeHtml(ellipsis(n.title || '文件夹', 14))}</span>
    </button>
  `;
}

// 溢出检测：放不下的书签隐藏起来收进「»」下拉面板
function layoutBar() {
  const bar = document.getElementById('bm-bar-list');
  const more = document.getElementById('bm-more');
  if (!barNodes.length) return;
  hiddenNodes = [];
  const byId = new Map(barNodes.map(n => [n.id, n]));
  const max = bar.clientWidth - 34; // 右侧预留「»」按钮位
  for (const item of bar.querySelectorAll('.bm-item')) {
    item.style.display = '';
    if (item.offsetLeft + item.offsetWidth > max) {
      item.style.display = 'none';
      const node = byId.get(item.dataset.bid);
      if (node) hiddenNodes.push(node);
    }
  }
  more.classList.toggle('hidden', hiddenNodes.length === 0);
}

function onBarClick(e) {
  const item = e.target.closest('.bm-item');
  if (!item) return;
  if (item.dataset.url) {
    navigateTo(item.dataset.url); // 当前标签跳转（同谷歌首页快捷方式）
    return;
  }
  if (item.classList.contains('bm-folder')) {
    const name = item.querySelector('.bm-name').textContent;
    if (pop && popAnchor === item) { closePop(); return; }
    openPop(item, { id: item.dataset.id, name });
  }
}

// 打开弹层面板（anchor：锚定按钮；root：navStack 根层级）
function openPop(anchor, root) {
  closePop();
  navStack.length = 0;
  navStack.push(root);
  popAnchor = anchor;
  pop = document.createElement('div');
  pop.className = 'bm-pop';
  document.body.appendChild(pop);
  pop.addEventListener('click', onPopClick);
  renderPopLevel();
  placePopover(pop, anchor, { width: 260, offsetY: 6, reserveH: 260 });
}

// 渲染当前层级的文件夹内容（含返回上一级行；root.nodes 有值则用快照不查 API）
async function renderPopLevel() {
  const cur = navStack[navStack.length - 1];
  const children = cur.nodes || await getChildren(cur.id);
  const backRow = navStack.length > 1
    ? `<button class="bm-pop-item bm-back" data-back="1">↩ ${escapeHtml(ellipsis(navStack[navStack.length - 2].name, 12))}</button>`
    : '';
  const rows = children.map(n => {
    if (n.url) {
      return `
        <button class="bm-pop-item" data-url="${escapeAttr(n.url)}" title="${escapeAttr(n.title || n.url)}">
          ${iconHtml(n.url)}
          <span class="bm-name">${escapeHtml(ellipsis(n.title || hostOf(n.url), 20))}</span>
        </button>
      `;
    }
    return `
      <button class="bm-pop-item" data-id="${n.id}">
        <span class="bm-icon bm-folder-icon">${FOLDER_SVG}</span>
        <span class="bm-name">${escapeHtml(ellipsis(n.title || '文件夹', 20))}</span>
        <span class="bm-arrow">›</span>
      </button>
    `;
  }).join('');
  pop.innerHTML = backRow + (rows || '<div class="bm-pop-empty">空文件夹</div>');
  wireFavicons(pop);
}

function onPopClick(e) {
  if (e.target.closest('[data-back]')) {
    navStack.pop();
    renderPopLevel();
    return;
  }
  const row = e.target.closest('.bm-pop-item');
  if (!row) return;
  if (row.dataset.url) {
    navigateTo(row.dataset.url);
    return;
  }
  // 子文件夹：进入下一层
  const name = row.querySelector('.bm-name').textContent;
  navStack.push({ id: row.dataset.id, name });
  renderPopLevel();
}

function closePop() {
  if (pop) { pop.remove(); pop = null; popAnchor = null; }
}

function ellipsis(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
