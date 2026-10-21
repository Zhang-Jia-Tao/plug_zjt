// js/fs-access.js — File System Access API 封装（只在 SW 中执行）
// 句柄由扩展页面（tree iframe / picker 页）选好后直接写入共享 IDB
// （chrome.runtime.sendMessage 无法序列化 FileSystemDirectoryHandle）。

import { getDirHandle, ensurePermission } from './handle-store.js';

// 扫描目录（一层），返回 { dirs: [{name}], files: [{name, size}] }
// 深层目录通过 path 数组逐层进入
export async function scanDirectory(dirId, path = []) {
  const entry = await getDirHandle(dirId);
  if (!entry) throw new Error('目录不存在或已被移除');
  // SW 中 requestPermission 需要用户手势：首次授权在 picker 页完成，
  // 后续 queryPermission granted 即可用（Chrome 对扩展 SW 有豁免）
  const ok = await ensurePermission(entry.handle);
  if (!ok) throw new Error('目录权限已失效，请重新添加目录');
  let dir = entry.handle;
  for (const seg of path) {
    dir = await dir.getDirectoryHandle(seg);
  }
  const dirs = [];
  const files = [];
  for await (const [name, node] of dir.entries()) {
    if (node.kind === 'directory') dirs.push({ name });
    else files.push({ name, size: (await node.getFile()).size });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  files.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
  return { dirName: dir.name, dirs, files };
}

// 读文件内容（文本）
export async function readFile(dirId, path, fileName) {
  const entry = await getDirHandle(dirId);
  if (!entry) throw new Error('目录不存在');
  const ok = await ensurePermission(entry.handle);
  if (!ok) throw new Error('目录权限已失效');
  let dir = entry.handle;
  for (const seg of path) dir = await dir.getDirectoryHandle(seg);
  const fh = await dir.getFileHandle(fileName);
  const file = await fh.getFile();
  return { name: file.name, size: file.size, content: await file.text() };
}

// 在 path 目录下新建子目录（重名自动加 (n) 后缀）
export async function createDirectory(dirId, path, name) {
  const entry = await getDirHandle(dirId);
  if (!entry) throw new Error('目录不存在');
  const ok = await ensurePermission(entry.handle);
  if (!ok) throw new Error('目录权限已失效');
  let dir = entry.handle;
  for (const seg of path) dir = await dir.getDirectoryHandle(seg);
  let finalName = name;
  let n = 1;
  while (true) {
    try {
      await dir.getDirectoryHandle(finalName);
      finalName = `${name} (${n})`;
      n++;
    } catch {
      break; // 不存在，可用
    }
  }
  await dir.getDirectoryHandle(finalName, { create: true });
  return { name: finalName };
}

// 写文件（粘贴建文件用；重名自动加 (n) 后缀避免覆盖）
export async function writeFile(dirId, path, fileName, content) {
  const entry = await getDirHandle(dirId);
  if (!entry) throw new Error('目录不存在');
  const ok = await ensurePermission(entry.handle);
  if (!ok) throw new Error('目录权限已失效');
  let dir = entry.handle;
  for (const seg of path) dir = await dir.getDirectoryHandle(seg);
  let name = fileName;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let n = 1;
  // 同名文件存在则加后缀
  while (true) {
    try {
      await dir.getFileHandle(name);
      name = `${stem} (${n})${ext}`;
      n++;
    } catch {
      break; // 不存在，可用
    }
  }
  const fh = await dir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(content);
  await w.close();
  return { name };
}
