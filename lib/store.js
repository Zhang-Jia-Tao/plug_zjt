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

// 标记某条便利贴的提醒已触发
export async function markReminded(id) {
  const notes = await getAllNotes();
  const n = notes.find(x => x.id === id);
  if (n) {
    n.reminded = true;
    await chrome.storage.local.set({ [KEY_NOTES]: notes });
  }
}

export async function saveNote(note) {
  const notes = await getAllNotes();
  const now = new Date().toISOString();
  let idx = notes.findIndex(n => n.id === note.id);
  if (idx >= 0) {
    const cur = notes[idx];
    // 若提醒时间被修改，重置 reminded 标记
    const remindChanged = note.remindAt !== undefined && note.remindAt !== cur.remindAt;
    notes[idx] = { ...cur, ...note, reminded: remindChanged ? false : cur.reminded, updatedAt: now };
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
      reminded: false,                       // 提醒是否已触发（用于错过补发去重）
      tasks: Array.isArray(note.tasks) ? note.tasks : [], // 规划清单任务列表
      blocks: Array.isArray(note.blocks) ? note.blocks : [], // 需求/缺陷/BUG 多内容块
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

const DONE_TAG = '已完成';

// 勾选/取消规划清单任务：更新 task.done；若绑定了关联卡片，追加/移除 title 的"已完成"标记
export async function toggleTask(noteId, taskId) {
  const notes = await getAllNotes();
  const note = notes.find(n => n.id === noteId);
  if (!note || !Array.isArray(note.tasks)) return null;
  const task = note.tasks.find(t => t.id === taskId);
  if (!task) return null;
  task.done = !task.done;

  // 处理关联卡片：勾选追加"已完成"，取消则移除
  if (task.linkedNoteId) {
    const linked = notes.find(n => n.id === task.linkedNoteId);
    if (linked) {
      if (task.done) {
        // 追加（若未已有）
        if (!linked.title.includes(DONE_TAG)) {
          linked.title = `${linked.title}（${DONE_TAG}）`;
        }
      } else {
        // 移除
        linked.title = linked.title.replace(`（${DONE_TAG}）`, '').replace(`(${DONE_TAG})`, '');
      }
      linked.updatedAt = new Date().toISOString();
    }
  }
  note.updatedAt = new Date().toISOString();
  await chrome.storage.local.set({ [KEY_NOTES]: notes });
  return note;
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
