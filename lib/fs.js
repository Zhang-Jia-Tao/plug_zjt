// fs.js — File System Access API 封装
// 绑定本地文件夹后，每条便利贴写一个 .md 文件到 <文件夹>/<分类key>/<id>.md
// 句柄存 IndexedDB（idb.js）跨会话复用。未绑定文件夹时所有操作静默跳过。
//
// 注意：showDirectoryPicker 必须由用户手势触发，只能在页面（sidepanel/options）调用，
// 不能在 service worker 调用。绑定后句柄传给 background，但 background 也无法直接弹 picker。
// 因此文件读写也放在页面上下文执行（sidepanel/options），background 只做消息路由。

import { idbGet, idbSet, idbDel } from './idb.js';
import { getCategory } from './categories.js';

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

// 全量同步：以本地 notes 为准，重写文件夹（删除多余文件、写入缺失文件）
// 用于"同步到文件夹"按钮或导入恢复后对齐
export async function syncFolderAll(notes) {
  const handle = await getFolderHandle();
  if (!handle) return { ok: false, reason: '未绑定文件夹' };
  if (!(await ensurePermission(handle))) return { ok: false, reason: '无文件夹权限' };

  // 1. 收集本地应有的文件集合: { "categoryKey/id.md" }
  const expected = new Set(notes.map(n => `${getCategory(n.category).key}/${n.id}.md`));

  // 2. 遍历已有分类目录与文件，删除不在 expected 中的
  for await (const [dirName, dirHandle] of handle.entries()) {
    if (dirHandle.kind !== 'directory') continue;
    for await (const [fileName, fileHandle] of dirHandle.entries()) {
      if (fileHandle.kind !== 'file' || !fileName.endsWith('.md')) continue;
      const rel = `${dirName}/${fileName}`;
      if (!expected.has(rel)) {
        try { await dirHandle.removeEntry(fileName); } catch {}
      }
    }
  }

  // 3. 写入所有 notes
  let written = 0;
  for (const n of notes) {
    try {
      await writeNoteFile(n);
      written++;
    } catch {}
  }
  return { ok: true, written, total: notes.length };
}
