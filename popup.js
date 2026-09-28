// popup.js — 快速查看（精简版）
import { getCategory, ACCOUNT_CATEGORIES } from './lib/categories.js';

const $ = (sel) => document.querySelector(sel);
let filter = 'all';

async function send(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ action, payload });
  if (!res || !res.ok) throw new Error(res?.message || '请求失败');
  return res.data;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

async function render() {
  const notes = await send('getNotes');
  const list = $('#plist');
  list.innerHTML = '';
  // 置顶优先 + 最近 8 条
  const filtered = notes.filter(n => filter === 'all' || n.category === filter).slice(0, 8);
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">暂无便利贴</div>';
    return;
  }
  for (const n of filtered) {
    const cat = getCategory(n.category);
    const el = document.createElement('div');
    el.className = 'pcard';
    el.style.setProperty('--cat-color', cat.color);
    const time = (n.updatedAt || '').slice(5, 16).replace('T', ' ');
    const isAccount = ACCOUNT_CATEGORIES.includes(n.category);
    const accountRows = isAccount ? `
      <div class="pcred" data-copy="${escapeAttr(n.username || '')}" title="点击复制账号">
        <span class="pcred-l">账号</span>
        <span class="pcred-v">${escapeHtml(n.username || '—')}</span>
      </div>
      <div class="pcred" data-copy="${escapeAttr(n.password || '')}" title="点击复制密码">
        <span class="pcred-l">密码</span>
        <span class="pcred-v">${escapeHtml(n.password || '—')}</span>
      </div>
    ` : '';
    el.innerHTML = `
      <div class="pcard-head">
        <div class="pcard-title">${n.pinned ? '⭐ ' : ''}${escapeHtml(n.title || '未命名')}</div>
        <button class="pedit" title="编辑">✎</button>
      </div>
      ${accountRows}
      ${!isAccount && n.content ? `<div class="pcard-content">${escapeHtml((n.content || '').slice(0, 80))}</div>` : ''}
      <div class="pcard-foot">${cat.icon} ${cat.label} · ${time}</div>
    `;
    el.addEventListener('click', async (e) => {
      // 编辑按钮 → 打开侧边栏聚焦编辑
      if (e.target.closest('.pedit')) {
        e.stopPropagation();
        chrome.storage.local.set({ pendingFocusId: n.id });
        openSidePanel();
        window.close();
        return;
      }
      // 账号/密码区域 → 复制对应值
      const cred = e.target.closest('.pcred');
      if (cred) {
        e.stopPropagation();
        const val = cred.dataset.copy;
        if (val) { try { await navigator.clipboard.writeText(val); flashEl(cred); } catch {} }
        return;
      }
      // 其余区域 → 复制整条内容
      const text = buildCopyText(n);
      if (text) { try { await navigator.clipboard.writeText(text); flashEl(el); } catch {} }
    });
    list.appendChild(el);
  }
}

function flashEl(el) {
  if (!el) return;
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 1000);
}

function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

// 按类别生成复制文本（与 sidepanel 一致）
function buildCopyText(n) {
  switch (n.category) {
    case 'account':
    case 'prod_account':
      return [n.username && `账号: ${n.username}`, n.password && `密码: ${n.password}`, n.content].filter(Boolean).join('\n');
    case 'url':
    case 'test_env':
    case 'prod_env':
      return n.url || n.content || n.title;
    case 'reminder':
    case 'meeting':
      return [n.title, n.remindAt ? `⏰ ${n.remindAt}` : '', n.content].filter(Boolean).join('\n');
    default:
      return [n.title, n.content].filter(Boolean).join('\n');
  }
}

async function openSidePanel() {
  // 在当前标签页打开侧边栏
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    try {
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {}
  }
}

function bind() {
  $('#btn-panel').addEventListener('click', () => { openSidePanel(); window.close(); });
  $('#btn-new').addEventListener('click', async () => {
    chrome.storage.local.set({ pendingNew: true });
    await openSidePanel();
    window.close();
  });
  $('#btn-options').addEventListener('click', () => chrome.runtime.openOptionsPage());
  $('#ptabs').addEventListener('click', (e) => {
    const t = e.target.closest('.ptab');
    if (!t) return;
    $('#ptabs').querySelectorAll('.ptab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    filter = t.dataset.cat;
    render();
  });
}

bind();
render();
