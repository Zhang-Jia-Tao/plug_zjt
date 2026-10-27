// notion.js — Notion API 客户端
// 在 service worker (background.js) 中调用，规避页面 CSP。
// 需用户在 options 页配置 notionToken + notionDatabaseId。
//
// Notion database 约定列：
//   必需：Title(title) / Category(select) / Content(rich_text)
//         / Pinned(checkbox) / NoteID(rich_text, 存本地 id 去重)
//   可选：URL(url) / RemindAt(date) / Username/Password/Host/Port
//         / Name/Phone/Email/IDCard/CustomFields（均为 rich_text）
//
// 兼容策略：推送前读取 database schema，只写数据库里存在且类型匹配的列；
// 可选列缺失时自动跳过（不会因用户没建 Username/Password 等列而 400）。
//
// API base: https://api.notion.com/v1
// Header: Authorization: Bearer <token>, Notion-Version: 2022-06-28

const API_BASE = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

// 列名 → 期望的 Notion 属性类型
const REQUIRED_PROPERTIES = {
  Title: 'title',
  Category: 'select',
  Content: 'rich_text',
  Pinned: 'checkbox',
  NoteID: 'rich_text',
};

const OPTIONAL_PROPERTIES = {
  URL: 'url',
  RemindAt: 'date',
  Username: 'rich_text',
  Password: 'rich_text',
  Host: 'rich_text',
  Port: 'rich_text',
  Name: 'rich_text',
  Phone: 'rich_text',
  Email: 'rich_text',
  IDCard: 'rich_text',
  CustomFields: 'rich_text',
};

function headers(token) {
  return {
    'Authorization': `Bearer ${token}`,
    'Notion-Version': NOTION_VERSION,
    'Content-Type': 'application/json',
  };
}

// 简单串行 + 重试，应对 ~3 req/s rate limit
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// 把多行 "标签: 值" 文本反解成自定义标签数组
function parseCustomFields(text) {
  if (!text) return [];
  return text.split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      const sep = line.indexOf(':');
      if (sep < 0) return { id: crypto.randomUUID(), label: line, value: '' };
      return { id: crypto.randomUUID(), label: line.slice(0, sep).trim(), value: line.slice(sep + 1).trim() };
    });
}
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

// 读取 database schema：返回 Map<列名, 属性类型>，并列出缺列/类型不符
export async function getDatabaseSchema(token, databaseId) {
  const r = await fetchJson(
    `${API_BASE}/databases/${databaseId}`,
    { method: 'GET', headers: headers(token) },
    { retries: 1 }
  );
  if (!r.ok) {
    return { ok: false, message: r.body?.message || `HTTP ${r.status}`, status: r.status };
  }
  const schema = new Map();
  for (const [name, def] of Object.entries(r.body?.properties || {})) {
    schema.set(name, def?.type || '');
  }
  const missingRequired = Object.entries(REQUIRED_PROPERTIES)
    .filter(([name, type]) => schema.get(name) !== type)
    .map(([name, type]) => `${name}(${type})`);
  const missingOptional = Object.entries(OPTIONAL_PROPERTIES)
    .filter(([name, type]) => schema.get(name) !== type)
    .map(([name, type]) => `${name}(${type})`);
  return { ok: true, schema, missingRequired, missingOptional };
}

// 连通性 + 权限测试：查询 database 第一页，并检查列是否齐全
export async function testConnection(token, databaseId) {
  const r = await fetchJson(
    `${API_BASE}/databases/${databaseId}/query`,
    { method: 'POST', headers: headers(token), body: JSON.stringify({ page_size: 1 }) },
    { retries: 1 }
  );
  if (!r.ok) {
    return {
      ok: false,
      message: r.body?.message || `HTTP ${r.status}`,
      status: r.status,
    };
  }
  const schemaRes = await getDatabaseSchema(token, databaseId);
  if (!schemaRes.ok) {
    return { ok: true, warning: `连接成功，但读取数据库结构失败：${schemaRes.message}` };
  }
  if (schemaRes.missingRequired.length) {
    return {
      ok: false,
      message: `数据库缺少必需列：${schemaRes.missingRequired.join('、')}`,
      missingRequired: schemaRes.missingRequired,
    };
  }
  return { ok: true, missingOptional: schemaRes.missingOptional };
}

// 把本地 note 映射成 Notion page properties。
// schema 为 Map<列名, 类型>；为空时按完整列写入（兼容旧调用/测试）。
export function buildNoteProperties(note, schema = null) {
  const canWrite = (name, type) => !schema || schema.get(name) === type;
  const props = {
    Title: { title: [{ text: { content: note.title || '未命名' } }] },
    Category: { select: note.category ? { name: note.category } : null },
    Content: { rich_text: [{ text: { content: (note.content || '').slice(0, 2000) } }] },
    Pinned: { checkbox: !!note.pinned },
    NoteID: { rich_text: [{ text: { content: note.id } }] },
  };
  if (note.url && canWrite('URL', 'url')) props.URL = { url: note.url };
  if (note.remindAt && canWrite('RemindAt', 'date')) props.RemindAt = { date: { start: note.remindAt } };
  if (note.username && canWrite('Username', 'rich_text')) props.Username = { rich_text: [{ text: { content: note.username } }] };
  if (note.password && canWrite('Password', 'rich_text')) props.Password = { rich_text: [{ text: { content: note.password } }] };
  if (note.host && canWrite('Host', 'rich_text')) props.Host = { rich_text: [{ text: { content: note.host } }] };
  if (note.port && canWrite('Port', 'rich_text')) props.Port = { rich_text: [{ text: { content: note.port } }] };
  if (note.name && canWrite('Name', 'rich_text')) props.Name = { rich_text: [{ text: { content: note.name } }] };
  if (note.phone && canWrite('Phone', 'rich_text')) props.Phone = { rich_text: [{ text: { content: note.phone } }] };
  if (note.email && canWrite('Email', 'rich_text')) props.Email = { rich_text: [{ text: { content: note.email } }] };
  if (note.idCard && canWrite('IDCard', 'rich_text')) props.IDCard = { rich_text: [{ text: { content: note.idCard } }] };
  // 个人信息自定义标签：拼成多行文本存到 CustomFields 列
  const customText = (Array.isArray(note.fields) ? note.fields : [])
    .filter(f => f.label || f.value)
    .map(f => `${f.label}: ${f.value}`)
    .join('\n');
  if (customText && canWrite('CustomFields', 'rich_text')) {
    props.CustomFields = { rich_text: [{ text: { content: customText.slice(0, 2000) } }] };
  }
  return props;
}

// 从 Notion page 反解出本地 note（用于 pull）
function pageToNote(page) {
  const p = page.properties || {};
  const getRichText = (f) => (f?.rich_text?.[0]?.plain_text) || '';
  const id = getRichText(p.NoteID) || page.id;  return {
    id,
    notionPageId: page.id,
    category: p.Category?.select?.name || 'url',
    title: p.Title?.title?.[0]?.plain_text || '未命名',
    content: getRichText(p.Content),
    url: p.URL?.url || '',
    username: getRichText(p.Username),
    password: getRichText(p.Password),
    host: getRichText(p.Host),
    port: getRichText(p.Port),
    name: getRichText(p.Name),
    phone: getRichText(p.Phone),
    email: getRichText(p.Email),
    idCard: getRichText(p.IDCard),
    // 自定义标签：从多行文本反解成 [{ label, value }]
    fields: parseCustomFields(getRichText(p.CustomFields)),
    remindAt: p.RemindAt?.date?.start || null,
    pinned: !!p.Pinned?.checkbox,
    createdAt: page.created_time || new Date().toISOString(),
    updatedAt: page.last_edited_time || new Date().toISOString(),
  };
}

// 推送单条（若该 NoteID 已存在则更新，否则新建）
// 简化策略：先 query 该 NoteID，命中则 PATCH 更新 properties，否则 POST 新建。
export async function pushNote(token, databaseId, note, existingPageId = null, schema = null) {
  const pageId = existingPageId;
  if (pageId) {
    // 更新
    const r = await fetchJson(
      `${API_BASE}/pages/${pageId}`,
      {
        method: 'PATCH',
        headers: headers(token),
        body: JSON.stringify({ properties: buildNoteProperties(note, schema) }),
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
        properties: buildNoteProperties(note, schema),
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
