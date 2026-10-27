// fs.js — File System Access API 封装
// 绑定本地文件夹后，每条便利贴写一个 .md 文件到 <文件夹>/<分类key>/<id>.md
// 句柄存 IndexedDB（idb.js）跨会话复用。未绑定文件夹时所有操作静默跳过。
//
// 注意：showDirectoryPicker 必须由用户手势触发，只能在页面（sidepanel/options）调用，
// 不能在 service worker 调用。绑定后句柄传给 background，但 background 也无法直接弹 picker。
// 因此文件读写也放在页面上下文执行（sidepanel/options），background 只做消息路由。

import { idbGet, idbSet, idbDel } from './idb.js';
import { getCategory, CATEGORY_MAP } from './categories.js';

const HANDLE_KEY = 'folderHandle';

// 绑定文件夹（页面调用，需用户手势）
export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await idbSet(HANDLE_KEY, handle);
  return handle.name;
}

// 解绑
export async function clearFolder() {
  await idbDel(HANDLE_KEY);
}

// 取已绑定的句柄（可能为 null）
export async function getFolderHandle() {
  return await idbGet(HANDLE_KEY);
}

// 确保权限：每次操作前校验，未授权则请求（请求需用户手势，在页面上下文）
export async function ensurePermission(handle) {
  if (!handle) return false;
  const opts = { mode: 'readwrite' };
  let perm = await handle.queryPermission(opts);
  if (perm === 'granted') return true;
  perm = await handle.requestPermission(opts);
  return perm === 'granted';
}

// 获取/创建分类子目录
async function getCategoryDir(rootHandle, categoryKey) {
  return await rootHandle.getDirectoryHandle(categoryKey, { create: true });
}

// 把一条便利贴写成 .md
export async function writeNoteFile(note) {
  const handle = await getFolderHandle();
  if (!handle) return false;
  if (!(await ensurePermission(handle))) return false;
  const cat = getCategory(note.category);
  const dir = await getCategoryDir(handle, cat.key);
  const fileHandle = await dir.getFileHandle(`${note.id}.md`, { create: true });
  const writable = await fileHandle.createWritable();

  const lines = [];
  lines.push(`# ${note.title || '未命名'}`);
  lines.push('');
  lines.push(`> 分类: ${cat.icon} ${cat.label}  |  ID: ${note.id}`);
  lines.push(`> 创建: ${note.createdAt || ''}  |  更新: ${note.updatedAt || ''}`);
  if (note.pinned) lines.push('> ⭐ 已置顶');
  lines.push('');
  if (note.url) {
    lines.push(`**链接**: ${note.url}`);
    lines.push('');
  }
  if (note.username || note.password) {
    lines.push(`**账号**: ${note.username || ''}`);
    lines.push(`**密码**: ${note.password || ''}`);
    lines.push('');
  }
  if (note.remindAt) {
    lines.push(`**提醒**: ${note.remindAt}`);
    lines.push('');
  }
  if (note.host || note.port) {
    lines.push(`**SSH Host**: ${note.host || ''}${note.port ? `:${note.port}` : ''}`);
    lines.push('');
  }
  if (note.name || note.phone || note.email || note.idCard) {
    if (note.name) lines.push(`**姓名**: ${note.name}`);
    if (note.phone) lines.push(`**电话**: ${note.phone}`);
    if (note.email) lines.push(`**邮箱**: ${note.email}`);
    if (note.idCard) lines.push(`**身份证号**: ${note.idCard}`);
    lines.push('');
  }
  if (Array.isArray(note.fields) && note.fields.length) {
    lines.push('## 自定义标签');
    for (const f of note.fields) {
      lines.push(`- **${f.label || ''}**: ${f.value || ''}`);
    }
    lines.push('');
  }
  if (cat.key === 'task_list' && Array.isArray(note.tasks) && note.tasks.length) {
    lines.push('## 任务清单');
    for (const t of note.tasks) {
      const mark = t.done ? '[x]' : '[ ]';
      const link = t.linkedNoteId ? ` (🔗 ${t.linkedNoteId})` : '';
      lines.push(`- ${mark} ${t.text || ''}${link}`);
    }
    lines.push('');
  }
  lines.push(note.content || '');
  await writable.write(lines.join('\n'));
  await writable.close();
  return true;
}

// 删除一条便利贴对应的 .md
export async function deleteNoteFile(note) {
  const handle = await getFolderHandle();
  if (!handle) return false;
  if (!(await ensurePermission(handle))) return false;
  const cat = getCategory(note.category);
  let dir;
  try {
    dir = await getCategoryDir(handle, cat.key);
  } catch {
    return false;
  }
  try {
    await dir.removeEntry(`${note.id}.md`);
    return true;
  } catch {
    return false; // 文件不存在视为成功删除
  }
}

// 全量同步：以本地 notes 为准，重写分类目录（删除多余文件、写入缺失文件）
// 用于"同步到文件夹"按钮或导入恢复后对齐。
//
// 安全边界（防止误删用户资料）：
//   1. 只扫描/清理 categories.js 中定义的分类目录；
//   2. 只清理文件名形如 UUID.md 的文件（本扩展生成的命名）；
//   3. 其他目录、非 .md 文件、非 UUID 命名的文件一律不碰。
export async function syncFolderAll(notes) {
  const handle = await getFolderHandle();
  if (!handle) return { ok: false, reason: '未绑定文件夹' };
  if (!(await ensurePermission(handle))) return { ok: false, reason: '无文件夹权限' };

  // 1. 读取已知分类目录中现有的 .md 文件，作为清理计划的输入
  const existingByDir = new Map();
  for await (const [dirName, dirHandle] of handle.entries()) {
    if (dirHandle.kind !== 'directory' || !CATEGORY_MAP[dirName]) continue;
    const files = [];
    for await (const [fileName, fileHandle] of dirHandle.entries()) {
      if (fileHandle.kind === 'file' && fileName.endsWith('.md')) files.push(fileName);
    }
    existingByDir.set(dirName, files);
  }

  // 2. 删除扩展自己分类目录中已不存在的 .md（纯函数，便于回归测试）
  let deleted = 0;
  for (const { dirName, fileName } of planFolderPrune(notes, existingByDir)) {
    try {
      const dir = await handle.getDirectoryHandle(dirName);
      await dir.removeEntry(fileName);
      deleted++;
    } catch {}
  }

  // 3. 写入所有 notes
  let written = 0;
  for (const n of notes) {
    try {
      await writeNoteFile(n);
      written++;
    } catch {}
  }
  return { ok: true, written, total: notes.length, deleted };
}

// 本扩展写入的文件名：<crypto.randomUUID()>.md
const NOTE_FILE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.md$/i;

// 期望写入的文件：分类目录 → 文件名集合（只含已知分类）
export function buildExpectedFileMap(notes) {
  const map = new Map();
  for (const n of notes) {
    const cat = getCategory(n.category);
    if (!CATEGORY_MAP[cat.key]) continue;
    if (!map.has(cat.key)) map.set(cat.key, new Set());
    map.get(cat.key).add(`${n.id}.md`);
  }
  return map;
}

// 纯函数：计算需要删除的文件。existingByDir: Map<目录名, 文件名数组>
// 未知目录、非 .md、非本扩展命名格式的文件都不在清理范围内。
export function planFolderPrune(notes, existingByDir) {
  const expected = buildExpectedFileMap(notes);
  const deletions = [];
  for (const [dirName, files] of existingByDir) {
    if (!CATEGORY_MAP[dirName]) continue;
    const keep = expected.get(dirName) || new Set();
    for (const fileName of files) {
      if (!NOTE_FILE_RE.test(fileName)) continue;
      if (!keep.has(fileName)) deletions.push({ dirName, fileName });
    }
  }
  return deletions;
}
