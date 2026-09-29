// sidepanel.js — 侧边栏主逻辑（ES module）
// 通过 chrome.runtime.sendMessage 与 background 通信做 CRUD/Notion/导出。
// 本地文件夹同步：saveNote/deleteNote 后直接调用 fs.js（页面上下文可用 File System Access API）。

import { CATEGORIES, getCategory, REMINDER_CATEGORIES, URL_CATEGORIES, ACCOUNT_CATEGORIES, LINKABLE_CATEGORIES, TASK_LIST_CATEGORY, FLASH_CATEGORY, ENV_CATEGORIES, MULTI_BLOCK_CATEGORIES } from './lib/categories.js';
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
  const isTaskList = cat === TASK_LIST_CATEGORY;
  const isFlash = cat === FLASH_CATEGORY;
  const isEnv = ENV_CATEGORIES.includes(cat);
  const isMultiBlock = MULTI_BLOCK_CATEGORIES.includes(cat);
  // 快闪笔记：只保留分类 + 内容，隐藏其余所有字段
  $('#f-title').closest('.field').classList.toggle('hidden', isFlash);
  $('#field-content').classList.toggle('hidden', isFlash === false && (isEnv || isMultiBlock));
  $('#field-blocks').classList.toggle('hidden', !isMultiBlock);
  $('#field-url').classList.toggle('hidden', !isUrl || isFlash);
  $('#field-account').classList.toggle('hidden', !isAccount || isFlash);
  $('#field-password').classList.toggle('hidden', !isAccount || isFlash);
  $('#field-remind').classList.toggle('hidden', !isReminder || isFlash);
  $('#field-tasks').classList.toggle('hidden', !isTaskList || isFlash);
  $('.field-inline').classList.toggle('hidden', isFlash); // 置顶开关
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
    list.appendChild(renderCard(n, notes));
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
    // 命令行区域不启动拖拽，让单击复制生效
    if (e.target.closest('.cmd-line, .cmd-comment')) { e.preventDefault(); return; }
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

function renderCard(n, allNotes = []) {
  const cat = getCategory(n.category);
  const el = document.createElement('div');
  el.className = 'note-card';
  el.dataset.id = n.id;
  el.draggable = true;
  el.style.setProperty('--cat-color', cat.color);
  const time = (n.updatedAt || '').slice(0, 16).replace('T', ' ');
  const isAccount = ACCOUNT_CATEGORIES.includes(n.category);

  // 按类别生成核心内容块（标题下、正文前优先展示）
  const core = renderCoreBlock(n, allNotes);

  // 账号类：账号/密码各自做成可点击的复制区域（即 core 的一部分，此处不重复）
  const accountRows = isAccount ? '' : '';

  el.innerHTML = `
    <div class="note-card-head">
      <div class="note-card-title">${escapeHtml(n.title || '未命名')}</div>
      <div class="note-card-cat">${cat.icon} ${cat.label}</div>
    </div>
    ${core}
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
    // 核心行（链接/时间）→ 复制对应值；命令块除外（鼠标选中复制）
    const coreBlock = e.target.closest('.core-row');
    if (coreBlock) {
      e.stopPropagation();
      const val = coreBlock.dataset.copy;
      if (val) await copyText(val, coreBlock);
      return;
    }
    // 命令行：单击复制该行命令
    const cmdLine = e.target.closest('.cmd-line');
    if (cmdLine) {
      e.stopPropagation();
      const val = cmdLine.dataset.copy;
      if (val) await copyText(val, cmdLine);
      return;
    }
    // 任务勾选框：切换完成状态
    if (e.target.matches('input[type="checkbox"][data-task]')) {
      e.stopPropagation();
      const noteId = e.target.dataset.note;
      const taskId = e.target.dataset.task;
      await send('toggleTask', { noteId, taskId });
      await render();
      toast(e.target.checked ? '任务已完成' : '任务取消完成');
      return;
    }
    // 任务关联标签：跳转打开关联卡片
    const linkTag = e.target.closest('.task-link-tag');
    if (linkTag) {
      e.stopPropagation();
      const linkedId = linkTag.dataset.link;
      const linked = await send('getNote', { id: linkedId });
      if (linked) openEditor(linked);
      return;
    }
    // 其余区域 → 复制整条内容
    await copyNote(n, el);
  });
  return el;
}

// 按类别生成卡片核心内容块：不同类别优先展示不同字段
function renderCoreBlock(n, allNotes = []) {
  switch (n.category) {
    case 'account':
    case 'prod_account':
      // 账号类：账号/密码行（可点击复制）
      return `
        <div class="cred-row" data-copy="${escapeAttr(n.username || '')}" title="点击复制账号">
          <span class="cred-label">账号</span>
          <span class="cred-val">${escapeHtml(n.username || '—')}</span>
        </div>
        <div class="cred-row" data-copy="${escapeAttr(n.password || '')}" title="点击复制密码">
          <span class="cred-label">密码</span>
          <span class="cred-val masked" data-pwd="${escapeAttr(n.password || '')}">${maskPwd(n.password)}</span>
        </div>
        ${n.content ? `<div class="note-card-content">${escapeHtml(n.content.slice(0, 80))}</div>` : ''}
      `;

    case 'url':
    case 'test_env':
    case 'prod_env':
      // 网址/环境类：链接优先，可点击复制
      return `
        ${n.url ? `
        <div class="core-row" data-copy="${escapeAttr(n.url)}" title="点击复制链接">
          <span class="core-label">🔗 链接</span>
          <span class="core-val mono">${escapeHtml(n.url)}</span>
        </div>` : ''}
        ${n.content ? `<div class="note-card-content">${escapeHtml(n.content.slice(0, 100))}</div>` : ''}
      `;

    case 'reminder':
    case 'meeting':
      // 提醒/会议类：时间优先醒目展示
      return `
        ${n.remindAt ? `
        <div class="core-row remind" data-copy="${escapeAttr(formatRemind(n.remindAt))}" title="点击复制时间">
          <span class="core-label">⏰ 时间</span>
          <span class="core-val">${escapeHtml(formatRemind(n.remindAt))}</span>
        </div>` : ''}
        ${n.content ? `<div class="note-card-content">${escapeHtml(n.content.slice(0, 100))}</div>` : ''}
      `;

    case 'server_cmd':
      // 服务器命令类：多行命令拆成独立命令框，每行单击复制；注释行自动加 # 前缀
      return renderCmdLines(n.content);

    case 'task_list':
      // 规划清单：展示任务列表，每项带勾选框
      return renderTaskList(n, allNotes);

    case 'flash':
      // 快闪笔记：直接显示内容
      return n.content
        ? `<div class="note-card-content flash-content">${escapeHtml(n.content)}</div>`
        : '<div class="note-card-content muted">（无内容）</div>';

    default:
      // 需求/缺陷/BUG 等：多内容块展示
      return renderBlocks(n);
  }
}

// 渲染多内容块（需求/缺陷/BUG）
function renderBlocks(n) {
  const blocks = Array.isArray(n.blocks) && n.blocks.length
    ? n.blocks
    : (n.content ? [{ id: 'legacy', text: n.content }] : []);
  if (blocks.length === 0) return '<div class="note-card-content muted">（无内容）</div>';
  return blocks.map((b, i) => `
    <div class="block-item">
      <span class="block-idx">${i + 1}</span>
      <div class="block-text">${escapeHtml(b.text)}</div>
    </div>
  `).join('');
}

// 渲染规划清单任务列表（卡片上）
function renderTaskList(n, allNotes = []) {
  const tasks = Array.isArray(n.tasks) ? n.tasks : [];
  if (tasks.length === 0) {
    return n.content
      ? `<div class="note-card-content">${escapeHtml(n.content.slice(0, 120))}</div>`
      : '<div class="note-card-content muted">（无任务）</div>';
  }
  const noteMap = new Map(allNotes.map(x => [x.id, x]));
  const items = tasks.map(t => {
    const linked = t.linkedNoteId ? noteMap.get(t.linkedNoteId) : null;
    let linkTag = '';
    let mainText = t.text || '';
    let subText = '';
    if (linked) {
      const lcat = getCategory(linked.category);
      // 关联标签用关联卡片图标
      linkTag = `<span class="task-link-tag" data-link="${escapeAttr(t.linkedNoteId)}" title="${escapeAttr(linked.title)}">${lcat.icon}</span>`;
      // 任务文本：优先用任务自填文本，无则用关联卡片标题
      mainText = mainText || linked.title || '未命名任务';
      // 副文本：关联卡片的标题+内容（截取）
      const ltitle = linked.title || '';
      const lcontent = (linked.content || '').slice(0, 60);
      subText = lcontent ? `${ltitle}：${lcontent}` : ltitle;
    }
    return `
      <label class="task-item ${t.done ? 'done' : ''}">
        <input type="checkbox" data-note="${n.id}" data-task="${t.id}" ${t.done ? 'checked' : ''} />
        <span class="task-main">
          <span class="task-text">${escapeHtml(mainText)}</span>
          ${subText ? `<span class="task-sub">${escapeHtml(subText)}</span>` : ''}
        </span>
        ${linkTag}
      </label>
    `;
  }).join('');
  return `<div class="task-list">${items}</div>${n.content ? `<div class="note-card-content">${escapeHtml(n.content.slice(0, 80))}</div>` : ''}`;
}

// 格式化提醒时间为本地可读格式
function formatRemind(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 解析服务器命令内容为行数组：每行 { text, isComment, copy }
// 规则：以 # 开头视为注释行（展示用，不单独复制）；其余为命令行（单击复制该行）
// 空行忽略
function parseCmdLines(content) {
  if (!content) return [];
  return content.split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
    .map(l => {
      const isComment = l.trimStart().startsWith('#');
      return { text: l, isComment, copy: isComment ? l : l };
    });
}

// 渲染多行命令：注释行 + 命令行各自独立框
function renderCmdLines(content) {
  const lines = parseCmdLines(content);
  if (lines.length === 0) return '<div class="note-card-content muted">（无命令）</div>';
  return lines.map(l => {
    if (l.isComment) {
      return `<div class="cmd-comment"><code>${escapeHtml(l.text)}</code></div>`;
    }
    return `<div class="cmd-line" data-copy="${escapeAttr(l.copy)}" title="单击复制命令"><code>${escapeHtml(l.text)}</code></div>`;
  }).join('');
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
    case 'server_cmd':
      // 服务器命令：复制所有命令行（不含注释行）
      return parseCmdLines(n.content).filter(l => !l.isComment).map(l => l.copy).join('\n') || n.title;
    case 'task_list':
      // 规划清单：复制任务清单（带勾选状态）
      return [n.title, ...(Array.isArray(n.tasks) ? n.tasks.map(t => `${t.done ? '[x]' : '[ ]'} ${t.text}`) : []), n.content].filter(Boolean).join('\n');
    case 'flash':
      // 快闪笔记：复制内容
      return n.content || n.title;
    default: {
      // 需求/缺陷/BUG：复制各内容块（带编号）
      const blocks = Array.isArray(n.blocks) && n.blocks.length ? n.blocks : (n.content ? [{ text: n.content }] : []);
      return [n.title, ...blocks.map((b, i) => `${i + 1}. ${b.text}`)].filter(Boolean).join('\n');
    }
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
  // 加载任务清单（规划清单类）
  editingTasks = Array.isArray(note?.tasks) ? note.tasks.map(t => ({ ...t })) : [];
  renderTaskEditor();
  // 加载多内容块（需求/缺陷/BUG 类）；若 blocks 为空但有 content，回退成单块
  if (Array.isArray(note?.blocks) && note.blocks.length) {
    editingBlocks = note.blocks.map(b => ({ ...b }));
  } else if (note?.content) {
    editingBlocks = [{ id: crypto.randomUUID(), text: note.content }];
  } else {
    editingBlocks = [];
  }
  renderBlockEditor();
  toggleConditionalFields();
  $('#editor').classList.remove('hidden');
  $('#f-title').focus();
}

function closeEditor() {
  $('#editor').classList.add('hidden');
  editingId = null;
  editingTasks = [];
  editingBlocks = [];
  linkedOptionsCache = null;
}

// ---- 任务清单编辑（规划清单类）----
let editingTasks = []; // 当前编辑中的任务数组
let linkedOptionsCache = null; // 可关联卡片列表缓存（本次编辑会话）

async function getLinkedOptions() {
  if (linkedOptionsCache) return linkedOptionsCache;
  const all = await send('getNotes');
  linkedOptionsCache = all.filter(n => LINKABLE_CATEGORIES.includes(n.category));
  return linkedOptionsCache;
}

function renderTaskEditor() {
  const box = $('#task-editor');
  box.innerHTML = '';
  if (editingTasks.length === 0) {
    box.innerHTML = '<div class="task-empty">暂无任务，点下方添加</div>';
    return;
  }
  editingTasks.forEach((t, i) => {
    const row = document.createElement('div');
    row.className = 'task-edit-row';
    row.dataset.idx = i;
    row.innerHTML = `
      <input type="checkbox" class="task-done" ${t.done ? 'checked' : ''} title="标记完成" />
      <input type="text" class="task-text" value="${escapeAttr(t.text || '')}" placeholder="任务内容" />
      <select class="task-link" title="关联卡片">
        <option value="">不关联</option>
      </select>
      <button type="button" class="task-del" title="删除任务">✕</button>
    `;
    box.appendChild(row);
    // 异步填充关联选项
    getLinkedOptions().then(opts => {
      const sel = row.querySelector('.task-link');
      const cur = sel.value;
      for (const o of opts) {
        const opt = document.createElement('option');
        opt.value = o.id;
        const cat = getCategory(o.category);
        opt.textContent = `${cat.icon} ${o.title}`;
        sel.appendChild(opt);
      }
      sel.value = t.linkedNoteId || cur;
    });
  });
}

function bindTaskEditorEvents() {
  $('#btn-add-task').addEventListener('click', () => {
    editingTasks.push({ id: crypto.randomUUID(), text: '', linkedNoteId: '', done: false });
    renderTaskEditor();
    // 聚焦最后一行
    const rows = $('#task-editor').querySelectorAll('.task-edit-row');
    if (rows.length) rows[rows.length - 1].querySelector('.task-text').focus();
  });
  $('#task-editor').addEventListener('click', (e) => {
    if (e.target.classList.contains('task-del')) {
      const row = e.target.closest('.task-edit-row');
      const idx = +row.dataset.idx;
      editingTasks.splice(idx, 1);
      renderTaskEditor();
    }
  });
  $('#task-editor').addEventListener('input', (e) => {
    const row = e.target.closest('.task-edit-row');
    if (!row) return;
    const idx = +row.dataset.idx;
    if (e.target.classList.contains('task-text')) editingTasks[idx].text = e.target.value;
  });
  $('#task-editor').addEventListener('change', (e) => {
    const row = e.target.closest('.task-edit-row');
    if (!row) return;
    const idx = +row.dataset.idx;
    if (e.target.classList.contains('task-done')) editingTasks[idx].done = e.target.checked;
    if (e.target.classList.contains('task-link')) editingTasks[idx].linkedNoteId = e.target.value;
  });
}

// 收集编辑器中的任务（保存时调用）
function collectTasks() {
  return editingTasks.map(t => ({
    id: t.id || crypto.randomUUID(),
    text: (t.text || '').trim(),
    linkedNoteId: t.linkedNoteId || '',
    done: !!t.done,
  })).filter(t => t.text || t.linkedNoteId);
}

// ---- 多内容块编辑（需求/缺陷/BUG 类）----
let editingBlocks = []; // 当前编辑中的内容块数组 [{ id, text }]

function renderBlockEditor() {
  const box = $('#block-editor');
  box.innerHTML = '';
  if (editingBlocks.length === 0) {
    box.innerHTML = '<div class="task-empty">暂无内容块，点下方添加</div>';
    return;
  }
  editingBlocks.forEach((b, i) => {
    const row = document.createElement('div');
    row.className = 'block-edit-row';
    row.dataset.idx = i;
    row.innerHTML = `
      <textarea class="block-text" rows="3" placeholder="内容块 ${i + 1}…">${escapeHtml(b.text || '')}</textarea>
      <button type="button" class="block-del" title="删除该块">✕</button>
    `;
    box.appendChild(row);
  });
}

function bindBlockEditorEvents() {
  $('#btn-add-block').addEventListener('click', () => {
    editingBlocks.push({ id: crypto.randomUUID(), text: '' });
    renderBlockEditor();
    const rows = $('#block-editor').querySelectorAll('.block-edit-row');
    if (rows.length) rows[rows.length - 1].querySelector('.block-text').focus();
  });
  $('#block-editor').addEventListener('click', (e) => {
    if (e.target.classList.contains('block-del')) {
      const row = e.target.closest('.block-edit-row');
      const idx = +row.dataset.idx;
      editingBlocks.splice(idx, 1);
      renderBlockEditor();
    }
  });
  $('#block-editor').addEventListener('input', (e) => {
    const row = e.target.closest('.block-edit-row');
    if (!row) return;
    const idx = +row.dataset.idx;
    if (e.target.classList.contains('block-text')) editingBlocks[idx].text = e.target.value;
  });
}

// 收集内容块（保存时调用）
function collectBlocks() {
  return editingBlocks.map(b => ({
    id: b.id || crypto.randomUUID(),
    text: (b.text || '').trim(),
  })).filter(b => b.text);
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
  const category = $('#f-category').value;
  let content = $('#f-content').value;
  // 服务器命令类：规范化注释行（# 开头的行确保 # 后有空格）
  if (category === 'server_cmd') content = normalizeCmdContent(content);
  // 快闪笔记：标题自动取内容首行（截取），无需用户填写
  let title = $('#f-title').value.trim();
  if (category === FLASH_CATEGORY) {
    title = (content.split('\n').find(l => l.trim()) || '快闪笔记').trim().slice(0, 40);
  }
  // 多内容块类：收集 blocks，content 同步为 blocks 拼接（兼容展示/复制/Notion）
  let blocks;
  if (MULTI_BLOCK_CATEGORIES.includes(category)) {
    blocks = collectBlocks();
    content = blocks.map(b => b.text).join('\n\n');
  }
  const note = {
    id: editingId || undefined,
    category,
    title,
    content,
    blocks,
    username: $('#f-username').value.trim(),
    password: $('#f-password').value,
    url: $('#f-url').value.trim(),
    remindAt: fromLocalInput($('#f-remind').value),
    pinned: $('#f-pinned').checked,
    tasks: category === TASK_LIST_CATEGORY ? collectTasks() : [],
  };
  const saved = await send('saveNote', { note });
  // 同步到本地文件夹（页面上下文）
  try { await writeNoteFile(saved); } catch {}
  closeEditor();
  await render();
  toast('已保存');
}

// 规范化服务器命令内容：
// - 以 # 开头的行视为注释，确保 # 后有一个空格（#xxx -> # xxx，#  xxx -> # xxx）
// - 其余行视为命令，保持原样
function normalizeCmdContent(content) {
  if (!content) return content;
  return content.split('\n').map(line => {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('#')) {
      const after = trimmed.replace(/^#+\s*/, '');
      return after ? `# ${after}` : '#';
    }
    return line;
  }).join('\n');
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
  bindTaskEditorEvents();
  bindBlockEditorEvents();
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
