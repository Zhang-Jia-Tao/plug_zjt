// notion.js — Notion API 客户端
// 在 service worker (background.js) 中调用，规避页面 CSP。
// 需用户在 options 页配置 notionToken + notionDatabaseId。
//
// Notion database 约定列：
//   Title(title) / Category(select) / Content(rich_text) / URL(url)
//   / RemindAt(date) / Pinned(checkbox) / NoteID(rich_text, 存本地 id 去重)
//
// API base: https://api.notion.com/v1
// Header: Authorization: Bearer <token>, Notion-Version: 2022-06-28

const API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// 简单串行 + 重试，应对 ~3 req/s rate limit
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchJson(url, opts, { retries = 2, retryDelay = 1200 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, opts);
      const text = await res.text();
      let body = null;
      try { body = text ? JSON.parse(text) : null; } catch { body = text; }
      if (res.ok) return { ok: true, status: res.status, body };
      // 429 / 5xx 重试
      if (res.status === 429 || res.status >= 500) {
        lastErr = { status: res.status, body };
        await sleep(retryDelay * (i + 1));
        continue;
      }
      return { ok: false, status: res.status, body };
    } catch (e) {
      lastErr = { status: 0, body: String(e) };
      await sleep(retryDelay * (i + 1));
    }
  }
  return { ok: false, status: lastErr?.status || 0, body: lastErr?.body };
}

// 连通性 + 权限测试：查询 database 第一页
export async function testConnection(token, databaseId) {
  const r = await fetchJson(
    `${API_BASE}/databases/${databaseId}/query`,
    { method: 'POST', headers: headers(token), body: JSON.stringify({ page_size: 1 }) },
    { retries: 1 }
  );
  if (r.ok) return { ok: true };
  return {
    ok: false,
    message: r.body?.message || `HTTP ${r.status}`,
    status: r.status,
  };
}

// 把本地 note 映射成 Notion page properties
function noteToProperties(note) {
  const props = {
    Title: { title: [{ text: { content: note.title || '未命名' } }] },
    Category: { select: note.category ? { name: note.category } : null },
    Content: { rich_text: [{ text: { content: (note.content || '').slice(0, 2000) } }] },
    Pinned: { checkbox: !!note.pinned },
    NoteID: { rich_text: [{ text: { content: note.id } }] },
  };
  if (note.url) props.URL = { url: note.url };
  if (note.remindAt) props.RemindAt = { date: { start: note.remindAt } };
  if (note.username) props.Username = { rich_text: [{ text: { content: note.username } }] };
  if (note.password) props.Password = { rich_text: [{ text: { content: note.password } }] };
  return props;
}

// 从 Notion page 反解出本地 note（用于 pull）
function pageToNote(page) {
  const p = page.properties || {};
  const getRichText = (f) => (f?.rich_text?.[0]?.plain_text) || '';
  const id = getRichText(p.NoteID) || page.id;
  return {
    id,
    notionPageId: page.id,
    category: p.Category?.select?.name || 'url',
    title: p.Title?.title?.[0]?.plain_text || '未命名',
    content: getRichText(p.Content),
    url: p.URL?.url || '',
    username: getRichText(p.Username),
    password: getRichText(p.Password),
    remindAt: p.RemindAt?.date?.start || null,
    pinned: !!p.Pinned?.checkbox,
    createdAt: page.created_time || new Date().toISOString(),
    updatedAt: page.last_edited_time || new Date().toISOString(),
  };
}

// 推送单条（若该 NoteID 已存在则更新，否则新建）
// 简化策略：先 query 该 NoteID，命中则 PATCH 更新 properties，否则 POST 新建。
export async function pushNote(token, databaseId, note, existingPageId = null) {
  const pageId = existingPageId;
  if (pageId) {
    // 更新
    const r = await fetchJson(
      `${API_BASE}/pages/${pageId}`,
      {
        method: 'PATCH',
        headers: headers(token),
        body: JSON.stringify({ properties: noteToProperties(note) }),
      },
      { retries: 1 }
    );
    return r.ok ? { ok: true, pageId } : { ok: false, message: r.body?.message };
  }
  // 新建
  const r = await fetchJson(
    `${API_BASE}/pages`,
    {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({
        parent: { database_id: databaseId },
        properties: noteToProperties(note),
      }),
    },
    { retries: 1 }
  );
  if (!r.ok) return { ok: false, message: r.body?.message || `HTTP ${r.status}` };
  return { ok: true, pageId: r.body?.id };
}

// 归档（软删除）
export async function archiveNote(token, pageId) {
  const r = await fetchJson(
    `${API_BASE}/pages/${pageId}`,
    {
      method: 'PATCH',
      headers: headers(token),
      body: JSON.stringify({ archived: true }),
    },
    { retries: 1 }
  );
  return r.ok ? { ok: true } : { ok: false, message: r.body?.message };
}

// 拉取全部：分页 query，按 NoteID 去重
export async function pullAll(token, databaseId, onProgress) {
  const all = [];
  let cursor;
  let page = 0;
  do {
    const body = { page_size: 100 };
    if (cursor) body.start_cursor = cursor;
    const r = await fetchJson(
      `${API_BASE}/databases/${databaseId}/query`,
      { method: 'POST', headers: headers(token), body: JSON.stringify(body) },
      { retries: 2 }
    );
    if (!r.ok) return { ok: false, message: r.body?.message || `HTTP ${r.status}` };
    const results = r.body?.results || [];
    all.push(...results);
    cursor = r.body?.has_more ? r.body?.next_cursor : undefined;
    page++;
    if (onProgress) onProgress(all.length);
    await sleep(350); // 留 rate limit 余量
  } while (cursor);

  // 去重：同一 NoteID 取最新
  const byId = new Map();
  for (const pg of all) {
    const n = pageToNote(pg);
    n.notionPageId = pg.id;
    const exist = byId.get(n.id);
    if (!exist || (n.updatedAt || '') > (exist.updatedAt || '')) byId.set(n.id, n);
  }
  return { ok: true, notes: [...byId.values()] };
}

// 建立 NoteID -> pageId 映射，用于增量推送时判断是否已存在
export async function buildIdMap(token, databaseId) {
  const r = await pullAll(token, databaseId);
  if (!r.ok) return r;
  const map = {};
  for (const n of r.notes) map[n.id] = n.notionPageId;
  return { ok: true, map };
}
