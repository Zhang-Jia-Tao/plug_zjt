// sidepanel.js — 侧边栏主逻辑（ES module）
// 通过 chrome.runtime.sendMessage 与 background 通信做 CRUD/Notion/导出。
// 本地文件夹同步：saveNote/deleteNote 后直接调用 fs.js（页面上下文可用 File System Access API）。

import { CATEGORIES, getCategory, REMINDER_CATEGORIES, URL_CATEGORIES, ACCOUNT_CATEGORIES } from './lib/categories.js';
import { writeNoteFile, deleteNoteFile, syncFolderAll, getFolderHandle } from './lib/fs.js';

const $ = (sel) => document.querySelector(sel);

let currentFilter = 'all';
let currentSearch = '';
let editingId = null; // null=新建

// ---- 消息封装 ----
async function send(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ action, payload });
  if (!res || !res.ok) throw new Error(res?.message || '请求失败');
  return res.data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---- 初始化 ----
async function init() {
  buildTabs();
  buildCategorySelect();
  bindEvents();
  await render();
  // 处理来自通知/popup 的待办意图
  const { pendingFocusId, pendingNew } = await chrome.storage.local.get(['pendingFocusId', 'pendingNew']);
  if (pendingFocusId) {
    await chrome.storage.local.remove('pendingFocusId');
    const note = await send('getNote', { id: pendingFocusId });
    openEditor(note || null);
  } else if (pendingNew) {
    await chrome.storage.local.remove('pendingNew');
    openEditor(null);
  }
}

function buildTabs() {
  const tabs = $('#category-tabs');
  tabs.innerHTML = '';
  const all = document.createElement('div');
  all.className = 'tab active';
  all.textContent = '全部';
  all.dataset.cat = 'all';
  tabs.appendChild(all);
  for (const c of CATEGORIES) {
    const el = document.createElement('div');
    el.className = 'tab';
    el.textContent = `${c.icon} ${c.label}`;
    el.dataset.cat = c.key;
    el.style.setProperty('--cat-color', c.color);
    tabs.appendChild(el);
  }
  tabs.addEventListener('click', (e) => {
    const t = e.target.closest('.tab');
    if (!t) return;
    tabs.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentFilter = t.dataset.cat;
    render();
  });
}

function buildCategorySelect() {
  const sel = $('#f-category');
  sel.innerHTML = '';
  for (const c of CATEGORIES) {
    const opt = document.createElement('option');
    opt.value = c.key;
    opt.textContent = `${c.icon} ${c.label}`;
    sel.appendChild(opt);
  }
  sel.addEventListener('change', toggleConditionalFields);
}

function toggleConditionalFields() {
  const cat = $('#f-category').value;
  const isUrl = URL_CATEGORIES.includes(cat);
  const isAccount = ACCOUNT_CATEGORIES.includes(cat);
  const isReminder = REMINDER_CATEGORIES.includes(cat);
  $('#field-url').classList.toggle('hidden', !isUrl);
  $('#field-account').classList.toggle('hidden', !isAccount);
  $('#field-password').classList.toggle('hidden', !isAccount);
  $('#field-remind').classList.toggle('hidden', !isReminder);
}

// ---- 渲染列表 ----
async function render() {
  const notes = await send('getNotes');
  const list = $('#note-list');
  list.innerHTML = '';
  const filtered = notes.filter(n => {
    if (currentFilter !== 'all' && n.category !== currentFilter) return false;
    if (currentSearch) {
      const q = currentSearch.toLowerCase();
      const hay = `${n.title} ${n.content} ${n.url || ''}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  if (filtered.length === 0) {
    list.innerHTML = '<div class="empty">暂无便利贴，点「+ 新建」添加</div>';
    return;
  }
  for (const n of filtered) {
    list.appendChild(renderCard(n));
  }
  enableDragSort();
}

// ---- 拖拽排序 ----
// 仅在「全部」视图且无搜索时启用（自定义顺序是全局顺序，分类/搜索下拖拽语义不清）
function dragEnabled() {
  return currentFilter === 'all' && !currentSearch;
}

function enableDragSort() {
  if (!dragEnabled()) return;
  const list = $('#note-list');
  let dragId = null;

  list.ondragstart = (e) => {
    const card = e.target.closest('.note-card');
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch {}
  };
  list.ondragend = (e) => {
    const card = e.target.closest('.note-card');
    if (card) card.classList.remove('dragging');
    list.querySelectorAll('.note-card').forEach(c => c.classList.remove('drag-over'));
    dragId = null;
  };
  list.ondragover = (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.note-card');
    if (!target || target.dataset.id === dragId) return;
    list.querySelectorAll('.note-card').forEach(c => c.classList.remove('drag-over'));
    target.classList.add('drag-over');
  };
  list.ondragleave = (e) => {
    if (!e.target.closest('.note-card')) {
      list.querySelectorAll('.note-card').forEach(c => c.classList.remove('drag-over'));
    }
  };
  list.ondrop = async (e) => {
    e.preventDefault();
    const target = e.target.closest('.note-card');
    if (!target || !dragId || target.dataset.id === dragId) return;
    // 按 DOM 顺序重排
    const cards = [...list.querySelectorAll('.note-card')];
    const ids = cards.map(c => c.dataset.id);
    // 把拖动项插到目标项之前
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(target.dataset.id);
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragId);
    list.querySelectorAll('.note-card').forEach(c => c.classList.remove('drag-over'));
    await send('reorder', { ids });
    await render();
    toast('已重新排序');
  };
}

function renderCard(n) {
  const cat = getCategory(n.category);
  const el = document.createElement('div');
  el.className = 'note-card';
  el.dataset.id = n.id;
  el.draggable = true;
  el.style.setProperty('--cat-color', cat.color);
  const preview = (n.content || '').slice(0, 120);
  const time = (n.updatedAt || '').slice(0, 16).replace('T', ' ');
  const isAccount = ACCOUNT_CATEGORIES.includes(n.category);

  // 账号类：账号/密码各自做成可点击的复制区域
  const accountRows = isAccount ? `
    <div class="cred-row" data-copy="${escapeAttr(n.username || '')}" title="点击复制账号">
      <span class="cred-label">账号</span>
      <span class="cred-val">${escapeHtml(n.username || '—')}</span>
    </div>
    <div class="cred-row" data-copy="${escapeAttr(n.password || '')}" title="点击复制密码">
      <span class="cred-label">密码</span>
      <span class="cred-val masked" data-pwd="${escapeAttr(n.password || '')}">${maskPwd(n.password)}</span>
    </div>
  ` : '';

  el.innerHTML = `
    <div class="note-card-head">
      <div class="note-card-title">${escapeHtml(n.title || '未命名')}</div>
      <div class="note-card-cat">${cat.icon} ${cat.label}</div>
    </div>
    ${accountRows}
    ${preview ? `<div class="note-card-content">${escapeHtml(preview)}</div>` : ''}
    <div class="note-card-foot">
      <span>${n.pinned ? '<span class="pin">⭐置顶</span>' : ''}${n.url ? '🔗' : ''}${n.remindAt ? '⏰' : ''}</span>
      <span class="foot-right">
        <span class="time">${time}</span>
        <button class="edit-btn" title="编辑">✎ 编辑</button>
      </span>
    </div>
  `;
  // 点击卡片主体 → 复制（编辑按钮、账号/密码区域、密码明文切换除外）
  el.addEventListener('click', async (e) => {
    // 编辑按钮 → 打开编辑
    if (e.target.closest('.edit-btn')) { e.stopPropagation(); openEditor(n); return; }
    // 账号/密码区域 → 复制对应值
    const credRow = e.target.closest('.cred-row');
    if (credRow) {
      e.stopPropagation();
      const val = credRow.dataset.copy;
      // 密码值点击切换明文/掩码，不复制
      const masked = e.target.closest('.cred-val.masked');
      if (masked) {
        const real = masked.dataset.pwd || '';
        if (masked.dataset.shown === '1') { masked.textContent = maskPwd(real); masked.dataset.shown = '0'; }
        else { masked.textContent = real || '—'; masked.dataset.shown = '1'; }
        return;
      }
      if (val) await copyText(val, credRow);
      return;
    }
    // 其余区域 → 复制整条内容
    await copyNote(n, el);
  });
  return el;
}

function maskPwd(p) {
  if (!p) return '—';
  return '•'.repeat(Math.min(p.length, 10));
}
function escapeAttr(s) {
  return String(s).replace(/"/g, '&quot;').replace(/'/g, '&#39;').replace(/</g, '&lt;');
}

// 按类别生成复制文本
function buildCopyText(n) {
  switch (n.category) {
    case 'account':
    case 'prod_account':
      // 账号类：账号 + 密码（卡片已有独立按钮，这里用于"复制全部"场景）
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

async function copyText(text, el) {
  if (!text) { toast('无内容'); return; }
  try {
    await navigator.clipboard.writeText(text);
    flashEl(el);
    toast('已复制');
  } catch { toast('复制失败'); }
}

async function copyNote(n, el) {
  await copyText(buildCopyText(n), el);
}

// 视觉反馈：给元素加 copied 类高亮，1.2s 后移除（不改内容，适配任意元素）
function flashEl(el) {
  if (!el) return;
  el.classList.add('copied');
  setTimeout(() => el.classList.remove('copied'), 1200);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

// 生成随机密码（用 crypto，避免 Math.random）
function genPassword(len = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789!@#$%&*';
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < len; i++) out += chars[buf[i] % chars.length];
  return out;
}

// ---- 编辑器 ----
function openEditor(note, presetCategory) {
  editingId = note ? note.id : null;
  $('#editor-mode').textContent = note ? '编辑便利贴' : '新建便利贴';
  $('#btn-delete').classList.toggle('hidden', !note);
  // 编辑时用 note 的分类；新建时若有预选分类（来自当前筛选）则用它，否则默认 url
  $('#f-category').value = note?.category || presetCategory || 'url';
  $('#f-title').value = note?.title || '';
  $('#f-content').value = note?.content || '';
  $('#f-username').value = note?.username || '';
  $('#f-password').value = note?.password || '';
  $('#f-url').value = note?.url || '';
  $('#f-remind').value = note?.remindAt ? toLocalInput(note.remindAt) : '';
  $('#f-pinned').checked = !!note?.pinned;
  toggleConditionalFields();
  $('#editor').classList.remove('hidden');
  $('#f-title').focus();
}

function closeEditor() {
  $('#editor').classList.add('hidden');
  editingId = null;
}

function toLocalInput(iso) {
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function fromLocalInput(v) {
  if (!v) return null;
  return new Date(v).toISOString();
}

async function onSave() {
  const note = {
    id: editingId || undefined,
    category: $('#f-category').value,
    title: $('#f-title').value.trim(),
    content: $('#f-content').value,
    username: $('#f-username').value.trim(),
    password: $('#f-password').value,
    url: $('#f-url').value.trim(),
    remindAt: fromLocalInput($('#f-remind').value),
    pinned: $('#f-pinned').checked,
  };
  const saved = await send('saveNote', { note });
  // 同步到本地文件夹（页面上下文）
  try { await writeNoteFile(saved); } catch {}
  closeEditor();
  await render();
  toast('已保存');
}

async function onDelete() {
  if (!editingId) return;
  if (!confirm('确认删除该便利贴？')) return;
  const note = await send('getNote', { id: editingId });
  await send('deleteNote', { id: editingId });
  try { if (note) await deleteNoteFile(note); } catch {}
  closeEditor();
  await render();
  toast('已删除');
}

// ---- 底栏操作 ----
async function onExport() {
  const choice = prompt('导出格式：输入 1 = JSON（可恢复导入），2 = Markdown（可读）。默认 1', '1');
  if (choice === null) return;
  if (choice === '2') {
    await send('exportMarkdown');
  } else {
    await send('exportJson');
  }
  toast('已开始下载');
}

async function onSync() {
  const settings = await send('getSettings');
  if (!settings.notionToken || !settings.notionDatabaseId) {
    toast('请先在设置页配置 Notion');
    chrome.runtime.openOptionsPage();
    return;
  }
  const op = prompt('同步方向：1 = 推送到 Notion（本地→云），2 = 从 Notion 拉取（云→本地，会覆盖本地）。默认 1', '1');
  if (op === null) return;
  toast('同步中…');
  try {
    if (op === '2') {
      const r = await send('notionPull');
      toast(`已拉取 ${r.pulled} 条`);
      await render();
    } else {
      const r = await send('notionPush');
      toast(`已推送 ${r.pushed}/${r.total}（失败 ${r.failed}）`);
    }
  } catch (e) {
    toast('同步失败：' + e.message);
  }
}

function onOptions() {
  chrome.runtime.openOptionsPage();
}

// ---- 事件绑定 ----
function bindEvents() {
  $('#btn-new').addEventListener('click', () => openEditor(null, currentFilter));
  $('#editor-close').addEventListener('click', closeEditor);
  $('#btn-save').addEventListener('click', onSave);
  $('#btn-delete').addEventListener('click', onDelete);
  $('#btn-genpwd').addEventListener('click', () => {
    $('#f-password').value = genPassword(12);
    $('#f-password').focus();
  });
  $('#btn-export').addEventListener('click', onExport);
  $('#btn-sync').addEventListener('click', onSync);
  $('#btn-options').addEventListener('click', onOptions);
  $('#search').addEventListener('input', (e) => {
    currentSearch = e.target.value.trim();
    render();
  });
  // ESC 关闭编辑器
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('#editor').classList.contains('hidden')) closeEditor();
  });
  // storage 变化时刷新（其他页面改动同步过来）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.notes) render();
  });
}

init();
