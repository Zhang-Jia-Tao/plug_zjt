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
    const core = renderCoreBlock(n, notes);
    el.innerHTML = `
      <div class="pcard-head">
        <div class="pcard-title">${n.pinned ? '⭐ ' : ''}${escapeHtml(n.title || '未命名')}</div>
        <button class="pedit" title="编辑">✎</button>
      </div>
      ${core}
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
      // 核心内容行（链接/时间）→ 复制对应值
      const core = e.target.closest('.pcore');
      if (core) {
        e.stopPropagation();
        const val = core.dataset.copy;
        if (val) { try { await navigator.clipboard.writeText(val); flashEl(core); } catch {} }
        return;
      }
      // 命令行：单击复制该行命令
      const cmdLine = e.target.closest('.pcmd-line');
      if (cmdLine) {
        e.stopPropagation();
        const val = cmdLine.dataset.copy;
        if (val) { try { await navigator.clipboard.writeText(val); flashEl(cmdLine); } catch {} }
        return;
      }
      // 其余区域 → 复制整条内容
      const text = buildCopyText(n);
      if (text) { try { await navigator.clipboard.writeText(text); flashEl(el); } catch {} }
    });
    list.appendChild(el);
  }
}

// 按类别生成卡片核心内容块（精简版）
function renderCoreBlock(n, allNotes = []) {
  switch (n.category) {
    case 'account':
    case 'prod_account':
      return `
        <div class="pcred" data-copy="${escapeAttr(n.username || '')}" title="点击复制账号">
          <span class="pcred-l">账号</span>
          <span class="pcred-v">${escapeHtml(n.username || '—')}</span>
        </div>
        <div class="pcred" data-copy="${escapeAttr(n.password || '')}" title="点击复制密码">
          <span class="pcred-l">密码</span>
          <span class="pcred-v">${escapeHtml(n.password || '—')}</span>
        </div>
      `;
    case 'url':
    case 'test_env':
    case 'prod_env':
      return `
        ${n.url ? `<div class="pcore" data-copy="${escapeAttr(n.url)}" title="点击复制链接"><span class="pcred-l">🔗</span><span class="pcred-v">${escapeHtml(n.url)}</span></div>` : ''}
        ${n.content ? `<div class="pcard-content">${escapeHtml(n.content.slice(0, 60))}</div>` : ''}
      `;
    case 'reminder':
    case 'meeting':
      return `
        ${n.remindAt ? `<div class="pcore remind" data-copy="${escapeAttr(formatRemind(n.remindAt))}"><span class="pcred-l">⏰</span><span class="pcred-v">${escapeHtml(formatRemind(n.remindAt))}</span></div>` : ''}
        ${n.content ? `<div class="pcard-content">${escapeHtml(n.content.slice(0, 60))}</div>` : ''}
      `;
    case 'server_cmd':
      return renderCmdLines(n.content);
    case 'task_list': {
      const tasks = Array.isArray(n.tasks) ? n.tasks : [];
      if (tasks.length === 0) return n.content ? `<div class="pcard-content">${escapeHtml(n.content.slice(0, 60))}</div>` : '';
      const noteMap = new Map((allNotes || []).map(x => [x.id, x]));
      const items = tasks.slice(0, 6).map(t => {
        const linked = t.linkedNoteId ? noteMap.get(t.linkedNoteId) : null;
        let icon = '☐';
        let text = t.text || '';
        if (linked) {
          const lcat = getCategory(linked.category);
          icon = t.done ? '☑' : lcat.icon;
          text = text || linked.title || '未命名';
          if (linked.content) text += ` · ${linked.content.slice(0, 30)}`;
        } else {
          icon = t.done ? '☑' : '☐';
        }
        return `<div class="ptask ${t.done ? 'done' : ''}">${icon} ${escapeHtml(text)}</div>`;
      }).join('');
      const more = tasks.length > 6 ? `<div class="ptask-more">…共 ${tasks.length} 项</div>` : '';
      return `<div class="ptask-list">${items}${more}</div>`;
    }
    case 'flash':
      return n.content ? `<div class="pcard-content flash">${escapeHtml(n.content.slice(0, 120))}</div>` : '';
    default: {
      // 需求/缺陷/BUG 等：取首个内容块预览
      const blocks = Array.isArray(n.blocks) && n.blocks.length ? n.blocks : (n.content ? [{ text: n.content }] : []);
      const preview = blocks[0]?.text || '';
      const more = blocks.length > 1 ? ` <span class="pblock-more">+${blocks.length - 1}</span>` : '';
      return preview ? `<div class="pcard-content">${escapeHtml(preview.slice(0, 80))}${more}</div>` : '';
    }
  }
}

function formatRemind(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, '0');
  return `${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function flashEl(el) {
  if (!el) return;
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 1000);
}

// 解析服务器命令为行数组
function parseCmdLines(content) {
  if (!content) return [];
  return content.split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
    .map(l => ({ text: l, isComment: l.trimStart().startsWith('#'), copy: l }));
}

// 渲染多行命令（popup 精简版）
function renderCmdLines(content) {
  const lines = parseCmdLines(content);
  if (lines.length === 0) return '';
  return lines.map(l => {
    if (l.isComment) {
      return `<div class="pcmd-comment"><code>${escapeHtml(l.text)}</code></div>`;
    }
    return `<div class="pcmd-line" data-copy="${escapeAttr(l.copy)}" title="单击复制命令"><code>${escapeHtml(l.text)}</code></div>`;
  }).join('');
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
    case 'server_cmd':
      return parseCmdLines(n.content).filter(l => !l.isComment).map(l => l.copy).join('\n') || n.title;
    case 'task_list':
      return [n.title, ...(Array.isArray(n.tasks) ? n.tasks.map(t => `${t.done ? '[x]' : '[ ]'} ${t.text}`) : []), n.content].filter(Boolean).join('\n');
    case 'flash':
      return n.content || n.title;
    default: {
      const blocks = Array.isArray(n.blocks) && n.blocks.length ? n.blocks : (n.content ? [{ text: n.content }] : []);
      return [n.title, ...blocks.map((b, i) => `${i + 1}. ${b.text}`)].filter(Boolean).join('\n');
    }
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
