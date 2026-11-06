// widgets/dependencyRadar.js — 依赖与漏洞雷达
// 读取公开 GitHub 仓库的 package.json / package-lock.json，扫描直接 npm 依赖，
// 通过 npm 官方安全公告批量接口列出已知漏洞。只读、不需要 Token。

const RAW_BASE = 'https://raw.githubusercontent.com';
const ADVISORY_URL = 'https://registry.npmjs.org/-/npm/v1/security/advisories/bulk';
const CACHE_KEY = 'dependency_radar_cache_v1';
const CACHE_TTL = 30 * 60 * 1000;
const CACHE_KEEP = 6 * 60 * 60 * 1000;
const CACHE_MAX = 12;
const MAX_DEPS = 40;
const MAX_ROWS = 8;
const SCAN_TIMEOUT = 20_000;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NON_REGISTRY_SPEC = /^(?:workspace:|file:|link:|portal:|patch:|catalog:|git\+|git:|github:|https?:|ssh:|npm:)/i;
const SEVERITIES = ['critical', 'high', 'moderate', 'low'];
const SEV_LABEL = { critical: '严重', high: '高危', moderate: '中危', low: '低危' };
const SEV_CLASS = { critical: 'sev-critical', high: 'sev-high', moderate: 'sev-moderate', low: 'sev-low' };

export function parseRepoInput(value) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  text = text.replace(/[?#].*$/, '').trim();
  const urlMatch = /^(?:https?:\/\/)?(?:www\.)?github\.com\/(.*)$/i.exec(text);
  const path = urlMatch ? urlMatch[1] : text.replace(/^git@github\.com:/i, '');
  const parts = path.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  if (!urlMatch && parts.length !== 2) return null;
  const owner = parts[0];
  const name = parts[1].replace(/\.git$/i, '');
  const repo = `${owner}/${name}`;
  if (!REPO_RE.test(repo)) return null;
  if ([owner, name].some((part) => part === '.' || part === '..')) return null;
  return repo;
}

function normalizeBranch(value) {
  const text = String(value ?? '').trim();
  if (!text) return 'HEAD';
  if (text.length > 120) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(text)) return null;
  if (text === '.' || text === '..' || text.includes('..')) return null;
  if (text.startsWith('/') || text.endsWith('/')) return null;
  return text;
}

function plainVersion(value) {
  return typeof value === 'string'
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value);
}

export function cleanSpecVersion(spec) {
  let text = String(spec ?? '').trim();
  if (!text || NON_REGISTRY_SPEC.test(text)) return '';
  text = text.replace(/^\s*[<>=~^]*\s*/, '').replace(/^v(?=\d)/i, '');
  const match = /^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)/.exec(text);
  return match ? match[1] : '';
}

function lockVersionFor(lock, name) {
  if (!lock || typeof lock !== 'object') return '';
  const entry = lock.packages && typeof lock.packages === 'object'
    ? lock.packages[`node_modules/${name}`]
    : null;
  if (entry && typeof entry === 'object' && !entry.link && plainVersion(entry.version)) return entry.version;
  const v1 = lock.dependencies && typeof lock.dependencies === 'object'
    ? lock.dependencies[name]
    : null;
  return v1 && typeof v1 === 'object' && plainVersion(v1.version) ? v1.version : '';
}

export function parsePackageDeps(pkgJson, lockJson) {
  const pkg = pkgJson && typeof pkgJson === 'object' ? pkgJson : {};
  const lock = lockJson && typeof lockJson === 'object' ? lockJson : null;
  const byName = new Map();
  for (const field of ['dependencies', 'devDependencies']) {
    const group = pkg[field];
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    for (const [rawName, rawSpec] of Object.entries(group)) {
      const name = String(rawName || '').trim();
      if (!name || byName.has(name)) continue;
      const spec = String(rawSpec ?? '').trim();
      const locked = lockVersionFor(lock, name);
      const version = locked || cleanSpecVersion(spec);
      if (!version) continue;
      const item = { name, version };
      aliasProp(item, 'package', name);
      aliasProp(item, 'pkg', name);
      aliasProp(item, 'spec', spec);
      aliasProp(item, 'locked', !!locked);
      byName.set(name, item);
    }
  }
  const all = [...byName.values()];
  const deps = all.slice(0, MAX_DEPS);
  Object.defineProperty(deps, 'source', {
    value: lock ? 'package-lock' : 'package.json',
    enumerable: false,
  });
  Object.defineProperty(deps, 'truncated', {
    value: all.length > MAX_DEPS,
    enumerable: false,
  });
  aliasProp(deps, 'hasLock', !!lock);
  aliasProp(deps, 'total', all.length);
  return deps;
}

export function severityRank(severity) {
  const index = SEVERITIES.indexOf(String(severity || '').toLowerCase());
  return index === -1 ? SEVERITIES.length : index;
}

function normalizeSeverity(value) {
  const text = String(value || '').toLowerCase();
  return SEVERITIES.includes(text) ? text : 'low';
}

function cvssScore(advisory) {
  const raw = advisory?.cvss;
  const value = raw && typeof raw === 'object' ? raw.score : raw;
  const score = Number(value ?? advisory?.cvss_score ?? advisory?.score);
  return Number.isFinite(score) ? score : null;
}

// 兼容别名：非枚举属性不参与 deepEqual / JSON，只方便按不同的字段名读取。
function aliasProp(target, name, value) {
  try {
    Object.defineProperty(target, name, { value, enumerable: false });
  } catch { /* 别名失败不影响主流程 */ }
  return target;
}

function safeHref(value) {
  try {
    const url = new URL(String(value || ''));
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : '';
  } catch {
    return '';
  }
}

export function normalizeAdvisories(payload, versions) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  const versionMap = new Map();
  if (Array.isArray(versions)) {
    for (const dep of versions) {
      if (dep && typeof dep === 'object' && dep.name) versionMap.set(String(dep.name), String(dep.version ?? ''));
    }
  } else if (versions instanceof Map) {
    for (const [name, version] of versions) versionMap.set(name, version);
  } else if (versions && typeof versions === 'object') {
    for (const [name, version] of Object.entries(versions)) versionMap.set(name, String(version));
  }

  const seen = new Set();
  const list = [];
  for (const [pkgName, advisories] of Object.entries(payload)) {
    if (!Array.isArray(advisories)) continue;
    const pkg = String(pkgName || '').trim();
    if (!pkg) continue;
    const version = versionMap.get(pkg) || '';
    for (const advisory of advisories) {
      if (!advisory || typeof advisory !== 'object') continue;
      const id = String(advisory.id ?? '');
      const title = String(advisory.title || advisory.overview || '未知漏洞').replace(/\s+/g, ' ').trim();
      const key = `${pkg}\u0000${version}\u0000${id || title}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const item = {
        package: pkg,
        version,
        severity: normalizeSeverity(advisory.severity),
        title: title.slice(0, 220),
        url: safeHref(advisory.url),
        range: String(advisory.vulnerable_versions || advisory.range || '').trim().slice(0, 140),
        cvss: cvssScore(advisory),
      };
      aliasProp(item, 'pkg', item.package);
      aliasProp(item, 'name', item.package);
      aliasProp(item, 'vulnerable_versions', item.range);
      aliasProp(item, 'vulnerableRange', item.range);
      aliasProp(item, 'id', id);
      aliasProp(item, 'score', item.cvss);
      list.push(item);
    }
  }
  return list.sort((a, b) => severityRank(a.severity) - severityRank(b.severity)
    || a.package.localeCompare(b.package, 'en')
    || a.title.localeCompare(b.title, 'en'));
}

function storageArea() {
  try {
    return typeof chrome !== 'undefined' && chrome?.storage?.local ? chrome.storage.local : null;
  } catch {
    return null;
  }
}

async function readCacheMap() {
  const area = storageArea();
  if (!area) return {};
  try {
    const got = await area.get(CACHE_KEY);
    const raw = got?.[CACHE_KEY];
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  } catch {
    return {};
  }
}

async function writeCacheMap(map) {
  const area = storageArea();
  if (!area) return;
  try {
    await area.set({ [CACHE_KEY]: map });
  } catch { /* 缓存失败不阻断主流程 */ }
}

function cacheId(repo, branch) {
  return `${repo}@${branch}`;
}

function freshEntry(entry) {
  return !!entry && Array.isArray(entry.deps) && Array.isArray(entry.vulns)
    && Number(entry.at) > 0 && Date.now() - Number(entry.at) < CACHE_TTL;
}

function pruneCache(map) {
  const now = Date.now();
  const entries = Object.entries(map || {})
    .filter(([, entry]) => entry && Number(entry.at) > 0)
    .sort((a, b) => Number(b[1].at) - Number(a[1].at));
  const kept = {};
  for (const [key, entry] of entries) {
    if (now - Number(entry.at) > CACHE_KEEP) continue;
    if (Object.keys(kept).length >= CACHE_MAX) break;
    kept[key] = entry;
  }
  return kept;
}

function abortError() {
  const error = new Error('aborted');
  error.name = 'AbortError';
  return error;
}

function notFoundError() {
  const error = new Error('not-found');
  error.kind = 'not-found';
  return error;
}

function networkError() {
  const error = new Error('network');
  error.kind = 'network';
  return error;
}

async function fetchJson(url, signal) {
  const response = await fetch(url, { cache: 'no-store', credentials: 'omit', signal });
  if (response.status === 404) return { status: 404, data: null };
  if (!response.ok) return { status: response.status, data: null };
  try {
    return { status: response.status, data: await response.json() };
  } catch {
    return { status: response.status, data: null, invalid: true };
  }
}

async function scanRepo(repo, branch, signal) {
  const base = `${RAW_BASE}/${repo}/${encodeURIComponent(branch)}`;
  let pkg;
  try {
    pkg = await fetchJson(`${base}/package.json`, signal);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw networkError();
  }
  if (pkg.status === 404) throw notFoundError();
  if (pkg.status !== 200) {
    const error = new Error('http');
    error.kind = 'http';
    error.status = pkg.status;
    throw error;
  }
  if (pkg.invalid || !pkg.data || typeof pkg.data !== 'object') {
    const error = new Error('parse');
    error.kind = 'parse';
    throw error;
  }

  let lock = null;
  try {
    const lockRes = await fetchJson(`${base}/package-lock.json`, signal);
    if (lockRes.status === 200 && lockRes.data && typeof lockRes.data === 'object') lock = lockRes.data;
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    lock = null;
  }

  const deps = parsePackageDeps(pkg.data, lock);
  const source = deps.source || (lock ? 'package-lock' : 'package.json');
  if (!deps.length) return { deps, vulns: [], source };

  const body = {};
  for (const dep of deps) body[dep.name] = [dep.version];
  let response;
  try {
    response = await fetch(ADVISORY_URL, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    throw networkError();
  }
  if (!response.ok) {
    const error = new Error('advisory');
    error.kind = 'advisory';
    error.status = response.status;
    throw error;
  }
  let payload;
  try {
    payload = await response.json();
  } catch {
    const error = new Error('advisory');
    error.kind = 'advisory';
    throw error;
  }
  return { deps, vulns: normalizeAdvisories(payload, deps), source };
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function setShown(node, shown) {
  if (!node) return;
  node.hidden = !shown;
  node.style.display = shown ? '' : 'none';
}

function errorText(err, timedOut) {
  if (timedOut) return '请求超时，请检查网络后重试';
  if (err?.kind === 'not-found') return '仓库或 package.json 不存在（404），请确认是公开仓库并检查分支';
  if (err?.kind === 'parse') return 'package.json 解析失败，请检查分支';
  if (err?.kind === 'advisory') return 'npm 安全公告服务暂不可用，请稍后重试';
  if (err?.kind === 'network') return '网络不可用，请检查代理后重试';
  if (err?.kind === 'http') return `仓库文件读取失败${err.status ? `（HTTP ${err.status}）` : ''}`;
  return '扫描失败，请稍后重试';
}

function sourceNote(source) {
  return source === 'package-lock'
    ? '仅扫描直接依赖 · 版本来自 lockfile'
    : '仅扫描直接依赖 · package.json 范围，结果可能偏保守';
}

function clockText(ts) {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export default {
  key: 'dependencyRadar',
  label: '依赖与漏洞雷达',
  description: '读取公开 GitHub 仓库的直接 npm 依赖，按严重度列出已知漏洞并缓存 30 分钟',
  defaultData: { repo: '', branch: 'HEAD' },
  config: [],

  init(container, data, api) {
    const el = document.createElement('div');
    el.className = 'mini-widget dr-widget';
    el.innerHTML = `
      <div class="mini-head">
        <span class="mini-icon dr-icon" aria-hidden="true">⚠</span>
        <div class="mini-copy">
          <div class="mini-title">依赖与漏洞雷达</div>
          <div class="mini-sub">未配置仓库</div>
        </div>
        <div class="mini-actions">
          <button type="button" class="mini-iconbtn dr-refresh" title="重新扫描（忽略缓存）" aria-label="重新扫描依赖漏洞">↻</button>
          <button type="button" class="mini-iconbtn dr-settings" title="更换仓库" aria-label="更换扫描的仓库">⚙</button>
        </div>
      </div>
      <div class="dr-summary" style="display:none"></div>
      <div class="mini-list dr-list" aria-live="polite"></div>
      <div class="mini-hint dr-note" style="display:none"></div>
    `;
    container.appendChild(el);

    const subEl = el.querySelector('.mini-sub');
    const summaryEl = el.querySelector('.dr-summary');
    const listEl = el.querySelector('.dr-list');
    const noteEl = el.querySelector('.dr-note');
    const refreshBtn = el.querySelector('.dr-refresh');
    const settingsBtn = el.querySelector('.dr-settings');

    let repo = parseRepoInput(data?.repo) || '';
    let branch = normalizeBranch(data?.branch) || 'HEAD';
    let draftRepo = repo || String(data?.repo || '');
    let lastEntry = null;
    let cacheMap = {};
    let cacheReady = readCacheMap().then((map) => {
      cacheMap = map;
      return map;
    }).catch(() => ({}));
    let controller = null;
    let activeTimer = 0;
    let requestSeq = 0;
    let destroyed = false;

    function contextLabel() {
      return branch === 'HEAD' ? repo : `${repo} @ ${branch}`;
    }

    function setSub(text) {
      subEl.textContent = text;
      subEl.title = repo ? contextLabel() : '';
    }

    function setBusy(busy) {
      refreshBtn.disabled = busy;
      listEl.setAttribute('aria-busy', String(busy));
    }

    function renderSetup() {
      requestSeq += 1;
      if (controller) {
        controller.abort();
        controller = null;
      }
      clearTimeout(activeTimer);
      activeTimer = 0;
      setBusy(false);
      el.dataset.state = 'setup';
      setSub(repo ? `${contextLabel()} · 待扫描` : '未配置仓库');
      setShown(summaryEl, false);
      setShown(noteEl, false);
      setShown(refreshBtn, false);
      setShown(settingsBtn, false);
      listEl.innerHTML = `
        <form class="mini-form dr-setup" novalidate>
          <div class="mini-form-row">
            <input class="mini-input" name="repo" value="${escapeHtml(draftRepo)}"
              placeholder="owner/repo 或 GitHub 链接" autocomplete="off" spellcheck="false" aria-label="GitHub 仓库">
          </div>
          <div class="mini-form-row">
            <input class="mini-input" name="branch" value="${escapeHtml(branch === 'HEAD' ? '' : branch)}"
              placeholder="分支（可选，默认 HEAD）" autocomplete="off" spellcheck="false" aria-label="分支">
            <button type="submit" class="mini-btn mini-btn-primary">${repo ? '保存' : '开始扫描'}</button>
            ${repo ? '<button type="button" class="mini-btn" data-act="cancel">取消</button>' : ''}
          </div>
          <div class="mini-hint">示例：vuejs/core、facebook/react；推荐有 package-lock 的仓库。</div>
          <div class="mini-warning" hidden></div>
        </form>
      `;
    }

    function renderLoading() {
      el.dataset.state = 'loading';
      setSub('正在扫描直接依赖…');
      setShown(summaryEl, false);
      setShown(noteEl, false);
      setShown(refreshBtn, true);
      setShown(settingsBtn, true);
      listEl.innerHTML = [
        ['读取 package.json', '解析 dependencies 与 devDependencies'],
        ['读取 package-lock.json', '对齐已安装的精确版本'],
        ['查询 npm 安全公告', '匹配漏洞与 CVSS'],
      ].map(([head, tail]) => `
        <div class="mini-row dr-row" aria-hidden="true">
          <div class="dr-main">
            <div class="dr-pkg">${escapeHtml(head)}<em>…</em></div>
            <div class="dr-title">${escapeHtml(tail)}</div>
          </div>
        </div>
      `).join('');
    }

    function pills(vulns) {
      const counts = { critical: 0, high: 0, moderate: 0 };
      for (const vuln of vulns) {
        const severity = normalizeSeverity(vuln.severity);
        if (severity in counts) counts[severity] += 1;
      }
      const out = [];
      if (counts.critical) out.push(`<span class="dr-pill high">严重 ${counts.critical}</span>`);
      if (counts.high) out.push(`<span class="dr-pill high">高危 ${counts.high}</span>`);
      if (counts.moderate) out.push(`<span class="dr-pill moderate">中危 ${counts.moderate}</span>`);
      return out.join('');
    }

    function rowHtml(vuln) {
      const severity = normalizeSeverity(vuln.severity);
      const pkg = String(vuln.package || '');
      const version = String(vuln.version || '');
      const title = String(vuln.title || '未知漏洞');
      const range = String(vuln.range || '');
      const score = Number(vuln.cvss);
      const hasScore = vuln.cvss != null && Number.isFinite(score);
      const meta = [
        hasScore ? `CVSS ${score.toFixed(1)}` : '',
        range ? `影响 ${range.slice(0, 34)}` : '',
      ].filter(Boolean).join(' · ');
      const tip = [
        `${pkg}${version ? `@${version}` : ''}`,
        title,
        range ? `影响范围：${range}` : '',
        hasScore ? `CVSS：${score.toFixed(1)}` : '',
      ].filter(Boolean).join('\n');
      const href = safeHref(vuln.url);
      const titleHtml = href
        ? `<a class="dr-title" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(tip)}">${escapeHtml(title)}</a>`
        : `<span class="dr-title" title="${escapeHtml(tip)}">${escapeHtml(title)}</span>`;
      return `
        <div class="mini-row dr-row" data-sev="${severity}">
          <div class="dr-main">
            <div class="dr-pkg" title="${escapeHtml(`${pkg}${version ? `@${version}` : ''}`)}">${escapeHtml(pkg)}${version ? `<em>@${escapeHtml(version)}</em>` : ''}</div>
            ${titleHtml}
            ${meta ? `<div class="dr-meta">${escapeHtml(meta)}</div>` : ''}
          </div>
          <span class="dr-sev ${SEV_CLASS[severity]}">${SEV_LABEL[severity]}</span>
        </div>`;
    }

    function renderResult(entry, cached = false) {
      lastEntry = entry;
      el.dataset.state = entry.vulns.length ? 'issues' : 'clean';
      setSub(contextLabel());
      setShown(refreshBtn, true);
      setShown(settingsBtn, true);
      summaryEl.innerHTML = `<span><b>${entry.deps.length}</b> 个直接依赖 · <b>${entry.vulns.length}</b> 个漏洞</span>${pills(entry.vulns)}`;
      setShown(summaryEl, true);

      if (!entry.vulns.length) {
        listEl.innerHTML = `
          <div class="mini-state mini-state-ok">
            <div aria-hidden="true">✓</div>
            <div>未发现已知漏洞</div>
          </div>`;
      } else {
        listEl.innerHTML = entry.vulns.slice(0, MAX_ROWS).map(rowHtml).join('');
      }
      listEl.scrollTop = 0;

      noteEl.textContent = sourceNote(entry.source);
      setShown(noteEl, true);
      noteEl.title = [
        `更新于 ${clockText(entry.at)}`,
        cached ? '来自缓存' : '',
        entry.vulns.length > MAX_ROWS ? `仅显示前 ${MAX_ROWS} 个，共 ${entry.vulns.length} 个漏洞` : '',
      ].filter(Boolean).join(' · ');
    }

    function renderError(err, timedOut) {
      el.dataset.state = 'error';
      setSub('扫描失败');
      setShown(summaryEl, false);
      setShown(noteEl, false);
      setShown(refreshBtn, true);
      setShown(settingsBtn, true);
      listEl.innerHTML = `
        <div class="mini-state mini-state-error">
          <div>${escapeHtml(errorText(err, timedOut))}</div>
          <button type="button" class="mini-btn" data-act="retry">重试</button>
        </div>`;
    }

    async function load(force = false) {
      if (destroyed || !repo) return;
      const seq = ++requestSeq;
      if (controller) controller.abort();
      const ctrl = new AbortController();
      controller = ctrl;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort();
      }, SCAN_TIMEOUT);
      activeTimer = timer;
      setBusy(true);

      try {
        await cacheReady;
        if (destroyed || seq !== requestSeq) return;
        const key = cacheId(repo, branch);
        const hit = force ? null : cacheMap[key];
        if (freshEntry(hit)) {
          renderResult(hit, true);
          return;
        }
        renderLoading();
        const result = await scanRepo(repo, branch, ctrl.signal);
        if (destroyed || seq !== requestSeq) return;
        const entry = { at: Date.now(), deps: result.deps, vulns: result.vulns, source: result.source };
        cacheMap[key] = entry;
        writeCacheMap(pruneCache(cacheMap));
        renderResult(entry);
      } catch (err) {
        if (destroyed || seq !== requestSeq) return;
        if (err?.name === 'AbortError' && !timedOut) return;
        renderError(err, timedOut);
      } finally {
        clearTimeout(timer);
        if (activeTimer === timer) activeTimer = 0;
        if (seq === requestSeq) {
          controller = null;
          setBusy(false);
        }
      }
    }

    function onSubmit(event) {
      const form = event.target;
      if (!(form instanceof Element) || !form.classList.contains('dr-setup')) return;
      event.preventDefault();
      const repoInput = form.querySelector('input[name="repo"]');
      const branchInput = form.querySelector('input[name="branch"]');
      const warning = form.querySelector('.mini-warning');
      const nextRepo = parseRepoInput(repoInput?.value);
      if (!nextRepo) {
        if (warning) {
          warning.hidden = false;
          warning.textContent = '请输入 owner/repo 或 GitHub 仓库链接';
        }
        repoInput?.focus();
        return;
      }
      const nextBranch = normalizeBranch(branchInput?.value);
      if (nextBranch === null) {
        if (warning) {
          warning.hidden = false;
          warning.textContent = '分支名仅支持字母、数字、. _ - /';
        }
        branchInput?.focus();
        return;
      }
      repo = nextRepo;
      branch = nextBranch;
      draftRepo = nextRepo;
      lastEntry = null;
      if (api?.patchWidget) api.patchWidget({ repo, branch });
      load(true);
    }

    function onClick(event) {
      const target = event.target instanceof Element ? event.target.closest('[data-act]') : null;
      if (!target || !el.contains(target)) return;
      if (target.dataset.act === 'refresh') load(true);
      else if (target.dataset.act === 'settings') {
        draftRepo = repo || draftRepo;
        renderSetup();
      } else if (target.dataset.act === 'cancel') {
        if (lastEntry) renderResult(lastEntry, true);
        else load();
      } else if (target.dataset.act === 'retry') {
        load(true);
      }
    }

    el.addEventListener('submit', onSubmit);
    el.addEventListener('click', onClick);

    if (repo) {
      renderLoading();
      load();
    } else {
      renderSetup();
    }

    return () => {
      destroyed = true;
      requestSeq += 1;
      if (controller) {
        controller.abort();
        controller = null;
      }
      clearTimeout(activeTimer);
      activeTimer = 0;
      el.removeEventListener('submit', onSubmit);
      el.removeEventListener('click', onClick);
    };
  },
};
