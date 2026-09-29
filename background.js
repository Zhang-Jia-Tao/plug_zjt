// background.js — MV3 service worker (ES module)
// 职责：消息路由、Notion API 执行、chrome.alarms 提醒、chrome.notifications、chrome.downloads 导出
// 所有状态在 chrome.storage，SW 重启可重建。不在内存缓存数据。

import { getAllNotes, getNote, saveNote, deleteNote, getSettings, setSettings, replaceAllNotes, sortNotes, reorderNotes, markReminded, toggleTask } from './lib/store.js';
import * as notion from './lib/notion.js';
import { getCategory } from './lib/categories.js';

// ---- 安装/启动：重建提醒 alarms ----

chrome.runtime.onInstalled.addListener(rebuildAlarms);
chrome.runtime.onStartup.addListener(rebuildAlarms);

async function rebuildAlarms() {
  const notes = await getAllNotes();
  const now = Date.now();
  const future = notes.filter(n => n.remindAt && new Date(n.remindAt).getTime() > now);
  // 清理已无提醒的 alarms
  const existing = await chrome.alarms.getAll();
  const validIds = new Set(future.map(n => n.id));
  for (const a of existing) {
    if (!validIds.has(a.name)) await chrome.alarms.clear(a.name);
  }
  for (const n of future) {
    chrome.alarms.create(n.id, { when: new Date(n.remindAt).getTime() });
  }
  // 补发错过的提醒：时间已过且未标记 reminded
  const missed = notes.filter(n => n.remindAt && new Date(n.remindAt).getTime() <= now && !n.reminded);
  for (const n of missed) {
    fireNotification(n);
    await markReminded(n.id);
  }
}

// ---- 提醒触发 ----

chrome.alarms.onAlarm.addListener(async (alarm) => {
  const note = await getNote(alarm.name);
  if (!note) return;
  fireNotification(note);
  await markReminded(note.id);
});

// 弹系统通知
function fireNotification(note) {
  const cat = getCategory(note.category);
  chrome.notifications.create(note.id, {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: `${cat.icon} ${cat.label}：${note.title}`,
    message: (note.content || '提醒时间到了').slice(0, 200),
    priority: 2,
  });
}

chrome.notifications.onClicked.addListener((notifId) => {
  // 记录待聚焦便利贴，由 sidepanel 启动时读取
  chrome.storage.local.set({ pendingFocusId: notifId });
  chrome.notifications.clear(notifId);
});

// ---- 便利贴变化时同步提醒 + 本地文件 ----
// 本地文件写入需在页面上下文（File System Access API），SW 无法直接弹权限请求。
// 因此 SW 只负责提醒 alarms；文件同步由 sidepanel 在 saveNote/deleteNote 后自行调用 fs.js。

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !changes.notes) return;
  await rebuildAlarms();
});

// ---- 消息路由 ----
// 统一入口：{ action, payload } -> 返回结果对象
// Notion 相关操作在此执行（SW 无页面 CSP 限制）

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      const result = await handleMessage(msg, sender);
      sendResponse({ ok: true, data: result });
    } catch (e) {
      sendResponse({ ok: false, message: String(e && e.message || e) });
    }
  })();
  return true; // 异步响应
});

async function handleMessage(msg, sender) {
  const { action, payload } = msg;
  switch (action) {

    case 'getNotes':
      return sortNotes(await getAllNotes());

    case 'getNote':
      return await getNote(payload.id);

    case 'saveNote': {
      const saved = await saveNote(payload.note);
      return saved;
    }

    case 'deleteNote':
      return await deleteNote(payload.id);

    case 'reorder':
      return await reorderNotes(payload.ids);

    case 'toggleTask':
      return await toggleTask(payload.noteId, payload.taskId);

    case 'getSettings':
      return await getSettings();

    case 'setSettings':
      return await setSettings(payload.patch);

    // ---- Notion ----
    case 'notionTest': {
      const s = await getSettings();
      return await notion.testConnection(s.notionToken, s.notionDatabaseId);
    }

    case 'notionPush': {
      // 增量推送：先建 id->pageId 映射，再逐条 push
      const s = await getSettings();
      if (!s.notionToken || !s.notionDatabaseId) throw new Error('未配置 Notion');
      const r = await notion.buildIdMap(s.notionToken, s.notionDatabaseId);
      if (!r.ok) throw new Error(r.message);
      const notes = await getAllNotes();
      const map = r.map;
      let pushed = 0, failed = 0;
      for (const n of notes) {
        const pr = await notion.pushNote(s.notionToken, s.notionDatabaseId, n, map[n.id] || null);
        if (pr.ok) { map[n.id] = pr.pageId; pushed++; }
        else failed++;
        await sleep(350);
      }
      await setSettings({ notionLastSync: new Date().toISOString() });
      return { pushed, failed, total: notes.length };
    }

    case 'notionPull': {
      const s = await getSettings();
      if (!s.notionToken || !s.notionDatabaseId) throw new Error('未配置 Notion');
      const r = await notion.pullAll(s.notionToken, s.notionDatabaseId);
      if (!r.ok) throw new Error(r.message);
      // 合并：以 NoteID 去重，本地已有则保留本地 id 的 createdAt，更新其余字段
      const local = await getAllNotes();
      const localMap = Object.fromEntries(local.map(n => [n.id, n]));
      const merged = r.notes.map(n => ({
        ...n,
        createdAt: localMap[n.id]?.createdAt || n.createdAt,
        pinned: localMap[n.id]?.pinned ?? n.pinned,
        tasks: localMap[n.id]?.tasks ?? n.tasks ?? [], // 保留本地任务清单（Notion 无此字段）
        blocks: localMap[n.id]?.blocks ?? n.blocks ?? [], // 保留本地多内容块（Notion 无此字段）
      }));
      await replaceAllNotes(merged);
      await setSettings({ notionLastSync: new Date().toISOString() });
      return { pulled: merged.length };
    }

    // ---- 导出 ----
    case 'exportJson': {
      const notes = await getAllNotes();
      const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), notes }, null, 2)], { type: 'application/json' });
      const dataUrl = await blobToDataUrl(blob);
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      return await downloadFile(`sticky-notes-${ts}.json`, dataUrl);
    }

    case 'exportMarkdown': {
      // 每条一个 .md，打包成单文件用分隔符
      const notes = await getAllNotes();
      const parts = notes.map(n => {
        const cat = getCategory(n.category);
        return [
          `# ${n.title}`,
          '',
          `> 分类: ${cat.icon} ${cat.label} | ID: ${n.id}`,
          `> 创建: ${n.createdAt} | 更新: ${n.updatedAt}${n.pinned ? ' | ⭐置顶' : ''}`,
          '',
          n.url ? `**链接**: ${n.url}\n` : '',
          n.remindAt ? `**提醒**: ${n.remindAt}\n` : '',
          n.content || '',
          '',
          '---',
          '',
        ].join('\n');
      });
      const md = parts.join('\n');
      const blob = new Blob([md], { type: 'text/markdown' });
      const dataUrl = await blobToDataUrl(blob);
      const ts = new Date().toISOString().slice(0, 10).replace(/-/g, '');
      return await downloadFile(`sticky-notes-${ts}.md`, dataUrl);
    }

    case 'importJson': {
      // payload.json 为解析后的对象
      const notes = payload?.notes || [];
      await replaceAllNotes(notes);
      return { imported: notes.length };
    }

    default:
      throw new Error(`未知 action: ${action}`);
  }
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function blobToDataUrl(blob) {
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

async function downloadFile(filename, dataUrl) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url: dataUrl, filename, saveAs: true, conflictAction: 'uniquify' },
      (id) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve({ id });
      }
    );
  });
}

// ---- 侧边栏：点图标打开 ----
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});
