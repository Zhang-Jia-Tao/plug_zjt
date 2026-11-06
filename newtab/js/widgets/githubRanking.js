// widgets/githubRanking.js — GitHub 星级榜
// 日/周/月读取 GitHub Trending（真实“周期新增 Star”排名）；年榜使用 Search API
// 的“近一年新建仓库按总 Star 排序”。Trending 不可用时自动降级为新项目榜。
const API_URL = 'https://api.github.com/search/repositories';
const TRENDING_URL = 'https://github.com/trending?since=';
const CACHE_KEY = 'github_ranking_cache_v1';
const MAX_FETCH = 20;

export const GITHUB_PERIODS = [
  { value: 'day', label: '日', days: 1, since: 'daily', sub: '今日热榜 · 新增 ★' },
  { value: 'week', label: '周', days: 7, since: 'weekly', sub: '本周热榜 · 新增 ★' },
  { value: 'month', label: '月', days: 30, since: 'monthly', sub: '本月热榜 · 新增 ★' },
  { value: 'year', label: '年', days: 365, since: null, sub: '年度新项目 · 总 ★' },
];

const SEARCH_SUB = {
  day: '今日新项目 · 总 ★',
  week: '本周新项目 · 总 ★',
  month: '本月新项目 · 总 ★',
  year: '年度新项目 · 总 ★',
};
const CACHE_TTL = {
  day: 10 * 60 * 1000,
  week: 15 * 60 * 1000,
  month: 30 * 60 * 1000,
  year: 6 * 60 * 60 * 1000,
};
const LANG_COLORS = {
  JavaScript: '#f1e05a',
  TypeScript: '#3178c6',
  Python: '#3572A5',
  Java: '#b07219',
  'C++': '#f34b7d',
  C: '#555555',
  'C#': '#178600',
  Go: '#00ADD8',
  Rust: '#dea584',
  HTML: '#e34c26',
  CSS: '#563d7c',
  Shell: '#89e051',
  Vue: '#41b883',
  Svelte: '#ff3e00',
  Ruby: '#701516',
  PHP: '#4F5D95',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  'Jupyter Notebook': '#DA5B0B',
  Dart: '#00B4AB',
  Lua: '#000080',
  'Objective-C': '#438eff',
  Scala: '#c22d40',
  Elixir: '#6e4a7e',
  Haskell: '#5e5086',
};

let sharedCache = null;

export function formatStars(value) {
  const n = Math.max(0, Math.round(Number(value) || 0));
  if (n >= 1_000_000) return `${compact(n / 1_000_000)}m`;
  if (n >= 1000) return `${compact(n / 1000)}k`;
  return String(n);
}

function compact(value) {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

export function parseCount(text) {
  const m = String(text ?? '').replace(/,/g, '').match(/([\d.]+)\s*([km])?/i);
  if (!m) return 0;
  const scale = m[2]?.toLowerCase() === 'm' ? 1_000_000 : m[2]?.toLowerCase() === 'k' ? 1000 : 1;
  return Math.round(Number(m[1]) * scale);
}

export function buildSearchUrl(period, now = Date.now()) {
  const item = periodOf(period);
  const since = new Date(Number(now) - item.days * 86_400_000).toISOString().slice(0, 10);
  const query = `created:>=${since} stars:>=20 fork:false archived:false`;
  return `${API_URL}?q=${encodeURIComponent(query)}&sort=stars&order=desc&per_page=30`;
}

function periodOf(value) {
  return GITHUB_PERIODS.find((item) => item.value === value) || GITHUB_PERIODS[0];
}

function safePart(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9_.-]+$/.test(value)
    && value !== '.'
    && value !== '..';
}

function decodePart(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function safeColor(value) {
  return /^(?:#[\da-f]{3,8}|rgba?\(\s*\d{1,3}\s*,\s*\d{1,3}\s*,\s*\d{1,3}(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\))$/i.test(value || '')
    ? value
    : null;
}

function colorForLanguage(language) {
  return LANG_COLORS[language] || '#8b949e';
}

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function parseTrending(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const nodes = [...doc.querySelectorAll('article.Box-row')];
  const items = [];
  for (const node of nodes) {
    const href = node.querySelector('h2 a[href]')?.getAttribute('href') || '';
    const path = href.replace(/^\/+/, '');
    const slash = path.indexOf('/');
    if (slash <= 0) continue;
    const owner = decodePart(path.slice(0, slash));
    const name = decodePart(path.slice(slash + 1).replace(/\/+$/, ''));
    if (!safePart(owner) || !safePart(name)) continue;

    const language = cleanText(node.querySelector('[itemprop="programmingLanguage"]')?.textContent);
    const color = safeColor(node.querySelector('.repo-language-color')?.style?.backgroundColor)
      || colorForLanguage(language);
    const gainedEl = node.querySelector('.float-sm-right');
    const gained = gainedEl && /star/i.test(gainedEl.textContent) ? parseCount(gainedEl.textContent) : null;

    items.push({
      owner,
      name,
      url: `https://github.com/${owner}/${name}`,
      description: cleanText(node.querySelector('p')?.textContent).slice(0, 280),
      language,
      color,
      stars: parseCount(node.querySelector('a[href$="/stargazers"]')?.textContent),
      gained,
    });
    if (items.length >= MAX_FETCH) break;
  }
  if (!items.length) throw new Error('GitHub 热榜页面结构已变化');
  return items;
}

function normalizeSearchItem(item) {
  const owner = item?.owner?.login || String(item?.full_name || '').split('/')[0];
  const name = item?.name || String(item?.full_name || '').split('/')[1];
  if (!safePart(owner) || !safePart(name)) return null;
  const language = cleanText(item.language);
  return {
    owner,
    name,
    url: `https://github.com/${owner}/${name}`,
    description: cleanText(item.description).slice(0, 280),
    language,
    color: colorForLanguage(language),
    stars: Math.max(0, Number(item.stargazers_count) || 0),
    gained: null,
  };
}

async function fetchTrending(period, signal) {
  const res = await fetch(`${TRENDING_URL}${period.since}`, {
    signal,
    credentials: 'omit',
    cache: 'no-store',
    headers: { Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`GitHub 热榜 ${res.status}`);
  return parseTrending(await res.text());
}

async function fetchSearch(period, signal) {
  const res = await fetch(buildSearchUrl(period.value), {
    signal,
    credentials: 'omit',
    cache: 'no-store',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) {
    if (res.status === 403 || res.status === 429) {
      const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const when = reset ? new Date(reset).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
      throw new Error(when ? `GitHub API 限流，${when} 后恢复` : 'GitHub API 限流，请稍后重试');
    }
    throw new Error(`GitHub API ${res.status}`);
  }
  const data = await res.json();
  const items = (Array.isArray(data.items) ? data.items : []).map(normalizeSearchItem).filter(Boolean).slice(0, MAX_FETCH);
  if (!items.length) throw new Error('该周期暂无新项目');
  return items;
}

async function fetchPeriod(period, signal) {
  if (period.since) {
    try {
      return { kind: 'trending', items: await fetchTrending(period, signal) };
    } catch (err) {
      if (signal.aborted || err?.name === 'AbortError') throw err;
      // 热榜页面不可解析/被限流时，降级到内容一致的新项目榜。
    }
  }
  return { kind: 'search', items: await fetchSearch(period, signal) };
}

async function readCache() {
  if (sharedCache) return sharedCache;
  try {
    const got = await chrome.storage.local.get(CACHE_KEY);
    const value = got?.[CACHE_KEY];
    sharedCache = value && typeof value === 'object' ? value : {};
  } catch {
    sharedCache = {};
  }
  return sharedCache;
}

async function writeCache() {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: sharedCache });
  } catch { /* 缓存失败不阻断主流程 */ }
}

function clockText(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function friendlyError(err) {
  if (err?.name === 'AbortError') return '请求超时，请检查网络后重试';
  const message = String(err?.message || '获取失败').replace(/^Error:\s*/, '');
  if (/failed to fetch|network|load failed/i.test(message)) return '网络不可用，请检查代理或稍后重试';
  return message.slice(0, 90);
}

function metricHtml(item) {
  if (Number.isFinite(item.gained) && item.gained > 0) {
    return `<span class="gh-delta">+${formatStars(item.gained)}</span>`;
  }
  return `<span class="gh-total"><span class="gh-star">★</span>${formatStars(item.stars)}</span>`;
}

export default {
  key: 'githubRanking',
  label: 'GitHub 星级榜',
  description: '日/周/月 GitHub 热榜与年度新项目 Star 排行，支持周期切换和缓存',
  defaultData: { period: 'day', showLimit: 10 },
  config: [
    {
      key: 'period',
      label: '默认周期',
      type: 'select',
      default: 'day',
      options: [
        { value: 'day', label: '日榜' },
        { value: 'week', label: '周榜' },
        { value: 'month', label: '月榜' },
        { value: 'year', label: '年榜' },
      ],
    },
    {
      key: 'showLimit',
      label: '显示数量',
      type: 'select',
      default: 10,
      options: [
        { value: 5, label: '5 个' },
        { value: 8, label: '8 个' },
        { value: 10, label: '10 个' },
        { value: 15, label: '15 个' },
      ],
    },
  ],

  init(container, data, api) {
    const el = document.createElement('div');
    const panelId = `gh-panel-${crypto.randomUUID()}`;
    el.className = 'github-widget';
    el.innerHTML = `
      <div class="gh-head">
        <div class="gh-brand">
          <span class="gh-logo" aria-hidden="true">
            <svg viewBox="0 0 16 16"><path fill="currentColor" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
          </span>
          <div class="gh-brand-text">
            <div class="gh-title">GitHub 星级榜</div>
            <div class="gh-sub" aria-live="polite">今日热榜 · 新增 ★</div>
          </div>
        </div>
        <div class="gh-actions">
          <span class="gh-updated" title=""></span>
          <button type="button" class="gh-refresh" title="刷新榜单" aria-label="刷新 GitHub 星级榜">⟳</button>
        </div>
      </div>
      <div class="gh-tabs" role="tablist" aria-label="榜单周期">
        ${GITHUB_PERIODS.map((item) => `
          <button type="button" class="gh-tab" role="tab" id="${panelId}-${item.value}"
            data-period="${item.value}" aria-controls="${panelId}" aria-selected="false" tabindex="-1">${item.label}</button>
        `).join('')}
      </div>
      <div class="gh-list" id="${panelId}" role="tabpanel" aria-live="polite" aria-busy="true"></div>
    `;
    container.appendChild(el);

    const tabsEl = el.querySelector('.gh-tabs');
    const listEl = el.querySelector('.gh-list');
    const subEl = el.querySelector('.gh-sub');
    const updatedEl = el.querySelector('.gh-updated');
    const refreshBtn = el.querySelector('.gh-refresh');
    const tabButtons = [...tabsEl.querySelectorAll('.gh-tab')];

    let active = periodOf(data.period).value;
    let cache = {};
    let booted = false;
    let destroyed = false;
    let requestSeq = 0;
    let controller = null;

    el.dataset.period = active;

    function syncTabs() {
      for (const btn of tabButtons) {
        const selected = btn.dataset.period === active;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', String(selected));
        btn.tabIndex = selected ? 0 : -1;
      }
    }

    function subFor(kind) {
      return kind === 'search' ? (SEARCH_SUB[active] || SEARCH_SUB.day) : (periodOf(active).sub);
    }

    function setBusy(busy) {
      el.classList.toggle('is-loading', busy);
      listEl.setAttribute('aria-busy', String(busy));
      refreshBtn.disabled = busy;
      refreshBtn.setAttribute('aria-busy', String(busy));
    }

    function renderSkeleton() {
      subEl.textContent = '正在获取 GitHub 榜单…';
      subEl.title = '';
      updatedEl.textContent = '';
      updatedEl.title = '';
      listEl.innerHTML = `
        <div class="gh-skeleton" aria-hidden="true">
          ${Array.from({ length: 6 }, (_, i) => `<div class="gh-sk-row" style="--i:${i}"></div>`).join('')}
        </div>
      `;
    }

    function renderEntry(entry) {
      el.classList.remove('is-stale');
      subEl.textContent = subFor(entry.kind);
      subEl.title = entry.kind === 'trending'
        ? 'GitHub 热榜：按该周期新增 Star 排序'
        : '新项目榜：按周期内新建仓库的总 Star 排序';
      const limit = Math.min(20, Math.max(3, Number(data.showLimit) || 10));
      const items = (Array.isArray(entry.items) ? entry.items : []).slice(0, limit);
      if (!items.length) {
        renderError('该周期暂无数据');
        return;
      }
      listEl.innerHTML = items.map((item, idx) => {
        const rank = String(idx + 1).padStart(2, '0');
        const top = idx < 3 ? ` top-${idx + 1}` : '';
        const color = safeColor(item.color) || colorForLanguage(item.language);
        const href = safePart(item.owner) && safePart(item.name)
          ? `https://github.com/${encodeURIComponent(item.owner)}/${encodeURIComponent(item.name)}`
          : '#';
        const stars = Math.max(0, Number(item.stars) || 0);
        const gained = Number(item.gained);
        const metricText = Number.isFinite(gained) && gained > 0
          ? `本期新增 ${gained.toLocaleString()} stars`
          : `总 Star ${stars.toLocaleString()}`;
        const title = [item.description, item.language ? `语言：${item.language}` : '', metricText].filter(Boolean).join('\n');
        return `
          <a class="gh-row" href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer"
            aria-label="${escapeHtml(`${idx + 1}. ${item.owner}/${item.name}，${metricText}`)}"
            title="${escapeHtml(title)}">
            <span class="gh-rank${top}">${rank}</span>
            <span class="gh-repo"><span class="gh-owner">${escapeHtml(item.owner)}/</span><span class="gh-name">${escapeHtml(item.name)}</span></span>
            ${item.language ? `<span class="gh-lang" style="background:${color}" title="${escapeHtml(item.language)}" aria-hidden="true"></span>` : ''}
            <span class="gh-stat">${metricHtml(item)}</span>
          </a>
        `;
      }).join('');
      listEl.scrollTop = 0;
      updatedEl.textContent = clockText(entry.at);
      updatedEl.title = `更新于 ${new Date(entry.at).toLocaleString('zh-CN')}`;
    }

    function renderError(message) {
      el.classList.remove('is-stale');
      subEl.textContent = '获取失败';
      subEl.title = '';
      updatedEl.textContent = '';
      updatedEl.title = '';
      listEl.innerHTML = `
        <div class="gh-state">
          <span class="gh-state-icon" aria-hidden="true">!</span>
          <p class="gh-state-text">${escapeHtml(message)}</p>
          <button type="button" class="gh-retry">重新加载</button>
        </div>
      `;
    }

    function markStale(entry) {
      el.classList.add('is-stale');
      subEl.textContent = `${subFor(entry.kind)} · 缓存`;
      updatedEl.title = '刷新失败，显示上次缓存';
    }

    function isFresh(entry) {
      return entry
        && Array.isArray(entry.items)
        && entry.items.length
        && Number(entry.at) > 0
        && Date.now() - Number(entry.at) < (CACHE_TTL[active] || CACHE_TTL.day);
    }

    async function load({ force = false } = {}) {
      if (destroyed) return;
      const seq = ++requestSeq;
      if (controller) controller.abort();
      const ctrl = new AbortController();
      controller = ctrl;
      const cached = cache[active];

      if (!force && isFresh(cached)) {
        renderEntry(cached);
        setBusy(false);
        controller = null;
        return;
      }
      if (cached && Array.isArray(cached.items) && cached.items.length) {
        renderEntry(cached);
        setBusy(true);
      } else {
        renderSkeleton();
        setBusy(true);
      }

      const timer = setTimeout(() => ctrl.abort(), 15_000);
      try {
        const result = await fetchPeriod(periodOf(active), ctrl.signal);
        if (destroyed || seq !== requestSeq) return;
        const entry = { kind: result.kind, items: result.items, at: Date.now() };
        cache[active] = entry;
        writeCache();
        renderEntry(entry);
      } catch (err) {
        if (destroyed || seq !== requestSeq) return;
        if (cached && Array.isArray(cached.items) && cached.items.length) {
          renderEntry(cached);
          markStale(cached);
        } else {
          renderError(friendlyError(err));
        }
      } finally {
        clearTimeout(timer);
        if (seq === requestSeq) {
          setBusy(false);
          controller = null;
        }
      }
    }

    async function boot() {
      cache = await readCache();
      if (destroyed) return;
      booted = true;
      syncTabs();
      await load();
    }

    function switchPeriod(next) {
      if (!next || next === active || !booted) return;
      active = next;
      el.dataset.period = active;
      syncTabs();
      api.patchWidget({ period: active });
      load();
    }

    tabsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('.gh-tab');
      if (!btn) return;
      switchPeriod(btn.dataset.period);
    });

    tabsEl.addEventListener('keydown', (e) => {
      const idx = GITHUB_PERIODS.findIndex((item) => item.value === active);
      let next = idx;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % tabButtons.length;
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + tabButtons.length) % tabButtons.length;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = tabButtons.length - 1;
      else return;
      e.preventDefault();
      const btn = tabButtons[next];
      btn.focus();
      switchPeriod(btn.dataset.period);
    });

    refreshBtn.addEventListener('click', () => load({ force: true }));
    listEl.addEventListener('click', (e) => {
      if (e.target.closest('.gh-retry')) load({ force: true });
    });

    renderSkeleton();
    syncTabs();
    boot();

    return () => {
      destroyed = true;
      requestSeq += 1;
      if (controller) controller.abort();
    };
  },
};
