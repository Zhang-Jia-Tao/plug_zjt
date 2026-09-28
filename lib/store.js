// store.js — chrome.storage.local 数据模型 CRUD
// 主存储为唯一可信源。所有便利贴以数组形式存在 key 'notes' 下。
// id 用 crypto.randomUUID()（MV3 service worker / 页面均可用）。

const KEY_NOTES = 'notes';
const KEY_SETTINGS = 'settings';

// ---- 便利贴 CRUD ----

export async function getAllNotes() {
  const { [KEY_NOTES]: notes } = await chrome.storage.local.get(KEY_NOTES);
  return Array.isArray(notes) ? notes : [];
}

export async function getNote(id) {
  const notes = await getAllNotes();
  return notes.find(n => n.id === id) || null;
}

export async function saveNote(note) {
  const notes = await getAllNotes();
  const now = new Date().toISOString();
  let idx = notes.findIndex(n => n.id === note.id);
  if (idx >= 0) {
    notes[idx] = { ...notes[idx], ...note, updatedAt: now };
  } else {
    const newNote = {
      id: note.id || crypto.randomUUID(),
      category: note.category || 'url',
      title: note.title || '未命名',
      content: note.content || '',
      url: note.url || '',
      username: note.username || '',
      password: note.password || '',
      remindAt: note.remindAt || null,
      pinned: !!note.pinned,
      order: note.order ?? nextOrder(notes), // 新建时排到末尾
      createdAt: note.createdAt || now,
      updatedAt: now,
    };
    notes.push(newNote);
    idx = notes.length - 1;
  }
  await chrome.storage.local.set({ [KEY_NOTES]: notes });
  return notes[idx];
}

export async function deleteNote(id) {
  const notes = await getAllNotes();
  const filtered = notes.filter(n => n.id !== id);
  await chrome.storage.local.set({ [KEY_NOTES]: filtered });
  return filtered;
}

// 排序：置顶在前，再按 order 升序（order 缺失视为最大，排末尾），最后 updatedAt 兜底
export function sortNotes(notes) {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const oa = a.order ?? Number.MAX_SAFE_INTEGER;
    const ob = b.order ?? Number.MAX_SAFE_INTEGER;
    if (oa !== ob) return oa - ob;
    return (b.updatedAt || '').localeCompare(a.updatedAt || '');
  });
}

// 新建便利贴的 order：取当前最大 order + 1
function nextOrder(notes) {
  let max = 0;
  for (const n of notes) if (typeof n.order === 'number' && n.order > max) max = n.order;
  return max + 1;
}

// 按给定 id 顺序批量重写 order（拖拽排序用）
export async function reorderNotes(orderedIds) {
  const notes = await getAllNotes();
  const byId = new Map(notes.map(n => [n.id, n]));
  orderedIds.forEach((id, i) => {
    const n = byId.get(id);
    if (n) n.order = i + 1;
  });
  await chrome.storage.local.set({ [KEY_NOTES]: notes });
  return sortNotes(notes);
}

// ---- 设置 ----

const DEFAULT_SETTINGS = {
  notionToken: '',
  notionDatabaseId: '',
  notionLastSync: null,        // ISO，最近一次成功同步时间
  folderBound: false,         // 是否绑定了本地文件夹（句柄本身存 IndexedDB）
  folderName: '',             // 绑定文件夹显示名
};

export async function getSettings() {
  const { [KEY_SETTINGS]: s } = await chrome.storage.local.get(KEY_SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}

export async function setSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ [KEY_SETTINGS]: next });
  return next;
}

// ---- 批量导入（恢复用）----

export async function replaceAllNotes(notes) {
  const clean = Array.isArray(notes) ? notes : [];
  await chrome.storage.local.set({ [KEY_NOTES]: clean });
  return clean;
}
