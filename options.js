// options.js — 设置页（ES module）
import { pickFolder, clearFolder, getFolderHandle, syncFolderAll } from './lib/fs.js';

const $ = (sel) => document.querySelector(sel);

async function send(action, payload = {}) {
  const res = await chrome.runtime.sendMessage({ action, payload });
  if (!res || !res.ok) throw new Error(res?.message || '请求失败');
  return res.data;
}

function setResult(el, text, isOk = true) {
  el.textContent = text;
  el.className = 'value ' + (isOk ? 'ok' : 'err');
}

// ---- 加载 ----
async function load() {
  const s = await send('getSettings');
  $('#notion-token').value = s.notionToken || '';
  $('#notion-db').value = s.notionDatabaseId || '';
  $('#last-sync').textContent = s.notionLastSync
    ? new Date(s.notionLastSync).toLocaleString('zh-CN')
    : '从未';
  await refreshFolder();
}

async function refreshFolder() {
  const handle = await getFolderHandle();
  if (handle) {
    $('#folder-name').textContent = handle.name;
    $('#btn-unbind').classList.remove('hidden');
  } else {
    $('#folder-name').textContent = '未绑定';
    $('#btn-unbind').classList.add('hidden');
  }
}

// ---- Notion ----
async function saveNotionSettings() {
  const token = $('#notion-token').value.trim();
  const db = $('#notion-db').value.trim();
  await send('setSettings', { patch: { notionToken: token, notionDatabaseId: db } });
}

async function onTest() {
  await saveNotionSettings();
  const el = $('#test-result');
  el.textContent = '测试中…'; el.className = 'value';
  try {
    const r = await send('notionTest');
    if (r.ok) setResult(el, '✓ 连接成功', true);
    else setResult(el, '✗ ' + (r.message || '失败'), false);
  } catch (e) {
    setResult(el, '✗ ' + e.message, false);
  }
}

// ---- 文件夹 ----
async function onBind() {
  try {
    const name = await pickFolder();
    await send('setSettings', { patch: { folderBound: true, folderName: name } });
    await refreshFolder();
    setResult($('#folder-sync-result'), '已绑定：' + name, true);
  } catch (e) {
    if (e.name !== 'AbortError') setResult($('#folder-sync-result'), '✗ ' + e.message, false);
  }
}

async function onUnbind() {
  await clearFolder();
  await send('setSettings', { patch: { folderBound: false, folderName: '' } });
  await refreshFolder();
}

async function onSyncFolder() {
  const el = $('#folder-sync-result');
  el.textContent = '同步中…'; el.className = 'value';
  const notes = await send('getNotes');
  try {
    const r = await syncFolderAll(notes);
    if (r.ok) setResult(el, `✓ 已写入 ${r.written}/${r.total}`, true);
    else setResult(el, '✗ ' + (r.reason || '失败'), false);
  } catch (e) {
    setResult(el, '✗ ' + e.message, false);
  }
}

// ---- 导入 ----
async function onImport() {
  const file = $('#import-file').files[0];
  if (!file) { setResult($('#import-result'), '请先选择文件', false); return; }
  try {
    const text = await file.text();
    const obj = JSON.parse(text);
    const r = await send('importJson', { json: obj });
    setResult($('#import-result'), `✓ 已导入 ${r.imported} 条`, true);
    // 同步到文件夹
    const notes = await send('getNotes');
    try { await syncFolderAll(notes); } catch {}
  } catch (e) {
    setResult($('#import-result'), '✗ ' + e.message, false);
  }
}

// ---- 绑定 ----
$('#btn-test').addEventListener('click', onTest);
$('#btn-bind').addEventListener('click', onBind);
$('#btn-unbind').addEventListener('click', onUnbind);
$('#btn-sync-folder').addEventListener('click', onSyncFolder);
$('#btn-import').addEventListener('click', onImport);
// token/db 失焦自动保存
$('#notion-token').addEventListener('blur', saveNotionSettings);
$('#notion-db').addEventListener('blur', saveNotionSettings);

load();
