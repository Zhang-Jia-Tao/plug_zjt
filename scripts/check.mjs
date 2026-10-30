// scripts/check.mjs — 无依赖静态回归检查
// 覆盖：manifest JSON、清单引用的资源、HTML 本地资源、跨扩展白名单一致性、widget 注册文件。
// 用法：node scripts/check.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const checks = [];

function note(name) { checks.push(name); }
function fail(message) { errors.push(message); }
function exists(rel, base = root) {
  const full = path.resolve(base, rel);
  if (!fs.existsSync(full)) { fail(`缺少文件：${path.relative(root, full)}`); return false; }
  return true;
}
function read(rel, base = root) {
  const full = path.resolve(base, rel);
  if (!exists(rel, base)) return '';
  return fs.readFileSync(full, 'utf8');
}
function readJson(rel) {
  try {
    const txt = read(rel);
    if (!txt) return null;
    return JSON.parse(txt);
  } catch (e) {
    fail(`${rel} JSON 解析失败：${e.message}`);
    return null;
  }
}

// 1. JSON 清单
const manifests = {};
for (const rel of [
  'manifest.json',
  'extension/manifest.json',
  'newtab/manifest.json',
  'ai_manager_host/com.zjt.ai_manager.json',
]) {
  manifests[rel] = readJson(rel);
  note(`JSON ${rel}`);
}

// 2. manifest 引用资源
function checkManifestFiles(rel) {
  const m = manifests[rel];
  if (!m) return;
  const dir = path.dirname(rel);
  const files = [];
  if (m.background?.service_worker) files.push(m.background.service_worker);
  if (m.action?.default_popup) files.push(m.action.default_popup);
  if (m.side_panel?.default_path) files.push(m.side_panel.default_path);
  if (m.options_page) files.push(m.options_page);
  for (const f of Object.values(m.icons || {})) files.push(f);
  for (const f of Object.values(m.action?.default_icon || {})) files.push(f);
  for (const cs of m.content_scripts || []) {
    files.push(...(cs.js || []), ...(cs.css || []));
  }
  for (const war of m.web_accessible_resources || []) files.push(...(war.resources || []));
  for (const f of files) exists(f, path.join(root, dir));
  note(`manifest 资源 ${rel}`);
}
for (const rel of Object.keys(manifests)) checkManifestFiles(rel);

// 3. HTML 本地资源
for (const rel of [
  'newtab/index.html',
  'newtab/tree.html',
  'newtab/file-picker.html',
  'newtab/offscreen.html',
  'extension/sidepanel.html',
  'extension/popup.html',
  'extension/options.html',
]) {
  const html = read(rel);
  if (!html) continue;
  const dir = path.join(root, path.dirname(rel));
  for (const m of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = m[1];
    if (/^(https?:|#|data:|chrome:|javascript:)/.test(ref)) continue;
    exists(ref, dir);
  }
  note(`HTML 资源 ${rel}`);
}

// 4. 跨扩展白名单：只允许新标签页扩展，且与 host 安装清单一致
const ext = manifests['extension/manifest.json'];
const host = manifests['ai_manager_host/com.zjt.ai_manager.json'];
if (ext?.externally_connectable) {
  const ids = ext.externally_connectable.ids || [];
  if (ids.includes('*')) fail('extension/manifest.json externally_connectable.ids 不能含 "*"');
  if (ext.externally_connectable.matches) fail('extension/manifest.json externally_connectable 不应开放网页 matches');
  const hostId = host?.allowed_origins?.[0]
    ?.replace(/^chrome-extension:\/\//, '')
    .replace(/\/$/, '');
  if (hostId && !ids.includes(hostId)) {
    fail(`跨扩展白名单 ${ids.join(',')} 与 host allowed_origins（${hostId}）不一致`);
  }
  note('跨扩展白名单');
}

// 5. widget 注册中心引用的文件都存在
const registry = read('newtab/js/widgets/registry.js');
if (registry) {
  for (const m of registry.matchAll(/from\s+['"](\.\/[^'"]+)['"]/g)) {
    exists(path.join('newtab/js/widgets', m[1]));
  }
  note('widget registry');
}

// 6. host 安装清单里的 launcher 存在
// 版本库里的 com.zjt.ai_manager.json 是可移植模板（<HOST_DIR> 占位），
// 真正的绝对路径由 install-host.bat 写到 gitignored 的 .local.json。
if (host?.path) {
  if (host.path.includes('<HOST_DIR>')) exists('ai_manager_host/run-host.bat');
  else exists(host.path);
  note('host launcher');
}

if (errors.length) {
  console.error('\n静态检查失败：');
  for (const e of errors) console.error(' - ' + e);
  process.exit(1);
}
console.log(`静态检查通过（${checks.length} 项）：JSON / manifest 资源 / HTML 资源 / 跨扩展白名单 / widget registry / host launcher`);
