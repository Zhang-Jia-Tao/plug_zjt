// tree.js — 目录树 iframe 页脚本
// 运行在扩展自己的 tree.html（iframe 注入到任意标签页 / newtab 页内嵌）。
// 扫描/读写走 SW（chrome.runtime.sendMessage）；添加目录时句柄直接写入共享 IDB
// （同源扩展页面共享 IndexedDB，且消息通道无法序列化 FileSystemDirectoryHandle），
// 然后发 tree:changed-broadcast 让各处刷新。
// 新建子目录：目录行 hover 出现 ＋，行内输入框回车创建（无弹窗）。

import { saveDirHandle } from './handle-store.js';

const $ = (sel) => document.querySelector(sel);

// 挂载的目录：[{ id, name }]
let dirs = [];
// 展开状态：dirId -> { 'a/b': true }
const expanded = {};
// 当前粘贴目标：{ dirId, path }
let pasteTarget = null;

function call(action, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ action, payload }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, message: chrome.runtime.lastError.message });
        return;
      }
      resolve(res || { ok: false, message: '无响应' });
    });
  });
}

function toast(msg, isError = false) {
  const el = $('#tree-toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2000);
}

// ---- 添加根目录：面板内直接调系统选择器，句柄直接写共享 IDB ----
async function addRootDir() {
  try {
    // ＋ 按钮点击 = 用户手势，iframe 内可调起
    const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
    // 授权（同一手势链内允许 requestPermission）
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
      const granted = await handle.requestPermission({ mode: 'readwrite' });
      if (granted !== 'granted') throw new Error('未授予目录访问权限');
    }
    // 直接写 IDB（消息通道无法序列化句柄）
    const id = crypto.randomUUID();
    await saveDirHandle({ id, name: handle.name, handle });
    toast(`已添加 ${handle.name}`);
    // 通知其他 tree iframe 刷新；自己也刷新
    await call('tree:changed-broadcast');
    loadDirs();
  } catch (e) {
    // 用户取消选择不算错误
    if (e && e.name === 'AbortError') return;
    toast(e.message || String(e), true);
  }
}

// ---- 目录挂载列表 ----
async function loadDirs() {
  const res = await call('tree:dirs');
  dirs = res.ok ? (res.data || []) : [];
  if (!res.ok) {
    $('#tree-list').innerHTML = `<p class="tree-empty">${escapeHtml(res.message)}</p>`;
    return;
  }
  render();
}

// ---- 渲染 ----
function render() {
  const list = $('#tree-list');
  if (dirs.length === 0) {
    list.innerHTML = `
      <p class="tree-empty">尚未挂载目录<br/>点右上角 ＋ 选择本地目录</p>
    `;
    return;
  }
  list.innerHTML = '';
  for (const d of dirs) {
    list.appendChild(renderDirRoot(d));
  }
}

function renderDirRoot(d) {
  const el = document.createElement('div');
  el.className = 'tree-dir-root';
  el.innerHTML = `
    <div class="tree-row dir-root" data-dir="${d.id}">
      <span class="tree-caret"></span>
      <span class="tree-icon">📂</span>
      <span class="tree-name">${escapeHtml(d.name)}</span>
      <button class="tree-mkdir-btn" data-mkdir-at="root" title="新建子目录">＋</button>
      <button class="tree-row-del" data-unmount="${d.id}" title="卸载目录">✕</button>
    </div>
    <div class="tree-children"></div>
  `;
  const row = el.querySelector('.tree-row');
  row.addEventListener('click', (e) => {
    if (e.target.closest('.tree-row-del') || e.target.closest('.tree-mkdir-btn')) return;
    toggleDir(d.id, [], row.nextElementSibling, row.querySelector('.tree-caret'));
  });
  el.querySelector('.tree-row-del').addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm(`卸载目录「${d.name}」？（不删除磁盘文件）`)) return;
    await call('tree:unmount', { dirId: d.id });
    delete expanded[d.id];
    loadDirs();
  });
  el.querySelector('.tree-mkdir-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    openMkdirInput(row.nextElementSibling, d.id, []);
  });
  return el;
}

// 展开/收起某目录的某层（path 数组）
async function toggleDir(dirId, path, container, caret) {
  const key = path.join('/');
  expanded[dirId] = expanded[dirId] || {};
  const isOpen = !!expanded[dirId][key];
  if (isOpen) {
    expanded[dirId][key] = false;
    container.innerHTML = '';
    caret.textContent = '▸';
    return;
  }
  caret.textContent = '▾';
  const res = await call('tree:list', { dirId, path });
  if (!res.ok) {
    container.innerHTML = `<p class="tree-empty">${escapeHtml(res.message)}</p>`;
    return;
  }
  expanded[dirId][key] = true;
  pasteTarget = { dirId, path }; // 最近展开的目录为粘贴目标
  renderLevel(container, res.data, dirId, path);
}

function renderLevel(container, data, dirId, path) {
  container.innerHTML = '';
  for (const sub of data.dirs) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    const childPath = [...path, sub.name];
    row.innerHTML = `
      <span class="tree-caret">▸</span>
      <span class="tree-icon">📁</span>
      <span class="tree-name">${escapeHtml(sub.name)}</span>
      <button class="tree-mkdir-btn" title="新建子目录">＋</button>
    `;
    const children = document.createElement('div');
    children.className = 'tree-children';
    row.addEventListener('click', (e) => {
      if (e.target.closest('.tree-mkdir-btn')) return;
      toggleDir(dirId, childPath, children, row.querySelector('.tree-caret'));
    });
    row.querySelector('.tree-mkdir-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      // 先确保该层已展开（新建后能看到），再插入输入行
      toggleDir(dirId, childPath, children, row.querySelector('.tree-caret'))
        .then(() => openMkdirInput(children, dirId, childPath));
    });
    container.appendChild(row);
    container.appendChild(children);
  }
  for (const f of data.files) {
    const row = document.createElement('div');
    row.className = 'tree-row file';
    row.innerHTML = `
      <span class="tree-caret"></span>
      <span class="tree-icon">${fileIcon(f.name)}</span>
      <span class="tree-name" title="${escapeAttr(f.name)} · ${fmtSize(f.size)}">${escapeHtml(f.name)}</span>
      <span class="tree-size">${fmtSize(f.size)}</span>
      <button class="tree-copy-btn" title="复制文件内容">⧉</button>
    `;
    row.addEventListener('click', async (e) => {
      if (e.target.closest('.tree-copy-btn')) {
        e.stopPropagation();
        await copyFile(dirId, path, f.name, row);
        return;
      }
      selectFile(row);
    });
    container.appendChild(row);
  }
}

// ---- 新建子目录：行内输入（无弹窗） ----
function openMkdirInput(container, dirId, path) {
  // 同一容器已有输入行则聚焦
  if (container.querySelector('.tree-mkdir-row')) {
    container.querySelector('.tree-mkdir-row input').focus();
    return;
  }
  const row = document.createElement('div');
  row.className = 'tree-row mkdir-row';
  row.innerHTML = `
    <span class="tree-caret"></span>
    <span class="tree-icon">📂</span>
    <input type="text" class="tree-mkdir-input" placeholder="目录名，回车创建" maxlength="60" />
  `;
  container.prepend(row);
  const input = row.querySelector('input');
  input.focus();
  const finish = (created) => {
    row.remove();
    if (created) reloadLevel(container, dirId, path);
  };
  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      const name = input.value.trim();
      if (!name) { finish(false); return; }
      const res = await call('tree:mkdir', { dirId, path, name });
      if (!res.ok) { toast(res.message, true); return; }
      toast(`已创建 ${res.data.name}`);
      finish(true);
    } else if (e.key === 'Escape') {
      finish(false);
    }
  });
  input.addEventListener('blur', () => {
    // 失焦且无内容则收起；有内容不误删（点别处 = 放弃）
    setTimeout(() => { if (!input.value.trim()) finish(false); }, 100);
  });
}

// 重载某层（新建目录/粘贴文件后刷新）
function reloadLevel(container, dirId, path) {
  expanded[dirId] = expanded[dirId] || {};
  expanded[dirId][path.join('/')] = false; // 强制重载
  // 找到该层对应的 caret（容器前面的目录行）
  const caret = container.previousElementSibling?.querySelector?.('.tree-caret');
  toggleDir(dirId, path, container, caret || { textContent: () => {} });
}

// 选中态（单选）
function selectFile(row) {
  document.querySelectorAll('.tree-row.selected').forEach(r => r.classList.remove('selected'));
  row.classList.add('selected');
}

async function copyFile(dirId, path, fileName, row) {
  const res = await call('tree:read', { dirId, path, fileName });
  if (!res.ok) {
    toast(res.message, true);
    return;
  }
  const wr = await call('tree:clipboard-write', { text: res.data.content });
  if (!wr.ok) {
    toast(wr.message, true);
    return;
  }
  selectFile(row);
  toast(`已复制 ${fileName}（${fmtSize(res.data.size)}）`);
}

// ---- 粘贴为文件 ----
async function pasteFromClipboard() {
  if (!pasteTarget) {
    toast('先展开一个目录作为粘贴目标', true);
    return;
  }
  const rd = await call('tree:clipboard-read');
  if (!rd.ok) {
    toast(rd.message, true);
    return;
  }
  const text = rd.data.text || '';
  if (!text.trim()) {
    toast('剪贴板没有文本内容', true);
    return;
  }
  const name = suggestFileName();
  const wr = await call('tree:write', {
    dirId: pasteTarget.dirId,
    path: pasteTarget.path,
    fileName: name,
    content: text,
  });
  if (!wr.ok) {
    toast(wr.message, true);
    return;
  }
  toast(`已保存 ${wr.data.name}`);
  // 刷新粘贴目标所在层
  const container = findContainerFor(pasteTarget);
  if (container) reloadLevel(container, pasteTarget.dirId, pasteTarget.path);
}

// 顶层容器查找（深层刷新简化为重载对应层：path 匹配 expanded 键）
function findContainerFor(target) {
  // 顶层
  if (target.path.length === 0) {
    const root = document.querySelector(`.tree-row[data-dir="${target.dirId}"]`);
    return root?.nextElementSibling || null;
  }
  // 深层：按路径逐层匹配（目录名拼接选择器不可靠，用文本匹配）
  let container = document.querySelector(`.tree-row[data-dir="${target.dirId}"]`)?.nextElementSibling;
  for (const seg of target.path) {
    if (!container) return null;
    let next = null;
    for (const child of container.children) {
      if (child.classList?.contains('tree-row') && child.querySelector('.tree-name')?.textContent === seg) {
        next = child.nextElementSibling;
        break;
      }
    }
    container = next;
  }
  return container;
}

function suggestFileName() {
  const d = new Date();
  const pad = (x) => String(x).padStart(2, '0');
  return `粘贴_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.txt`;
}

// ---- 工具 ----
function fileIcon(name) {
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (['js', 'mjs', 'ts'].includes(ext)) return '📜';
  if (['html', 'htm', 'vue', 'jsx', 'tsx'].includes(ext)) return '🌐';
  if (['css', 'scss', 'less'].includes(ext)) return '🎨';
  if (['json'].includes(ext)) return '🧩';
  if (['md', 'markdown', 'txt'].includes(ext)) return '📄';
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp'].includes(ext)) return '🖼️';
  if (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext)) return '🗜️';
  if (['exe', 'msi', 'apk'].includes(ext)) return '⚙️';
  return '📄';
}

function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }

// ---- 事件绑定 ----
$('#btn-add-dir').addEventListener('click', addRootDir);
$('#btn-refresh').addEventListener('click', () => loadDirs());
$('#btn-paste').addEventListener('click', pasteFromClipboard);

// SW 广播（picker 添加目录后）刷新
chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.action === 'tree:changed') loadDirs();
});

loadDirs();
