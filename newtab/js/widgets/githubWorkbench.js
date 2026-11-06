// widgets/githubWorkbench.js — GitHub 工作台
// 三个视图：待我审 / 我的 PR / CI 失败。
// 认证使用 Personal Access Token：Token 单独存放在 chrome.storage.local
// （key: github_workbench_token_v1），不写入 newtab_state，也不会回填到 DOM。
// 所有远端文本一律转义后再拼接 innerHTML；Token 只出现在请求头里，不进入 URL。

export const TOKEN_STORAGE_KEY = 'github_workbench_token_v1';

const API_ROOT = 'https://api.github.com';
const SEARCH_API = `${API_ROOT}/search/issues`;
const USER_API = `${API_ROOT}/user`;
const GRAPHQL_API = `${API_ROOT}/graphql`;
const GITHUB_API_VERSION = '2022-11-28';
const CACHE_TTL = 120_000;
const REQUEST_TIMEOUT = 15_000;
const MAX_ITEMS = 20;
const MAX_TITLE = 200;

const GITHUB_MARK = `<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.012 8.012 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>`;

export const WORKBENCH_TABS = [
  { key: 'review', label: '待我审', empty: '没有待你审的 PR' },
  { key: 'mine', label: '我的 PR', empty: '没有打开的 PR' },
  { key: 'ci', label: 'CI 失败', empty: 'CI 没有失败' },
];

export const CI_QUERY = `query GithubWorkbenchFailedChecks {
  viewer {
    pullRequests(states: OPEN, first: ${MAX_ITEMS}, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number
        title
        url
        isDraft
        updatedAt
        repository { nameWithOwner }
        commits(last: 1) {
          nodes { commit { statusCheckRollup { state } } }
        }
      }
    }
  }
}`;

// ---------- 静态工具函数（可单测，无 DOM / chrome 依赖） ----------

export function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function compactText(value, max = 0) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return max > 0 ? text.slice(0, max) : text;
}

function safePathPart(value) {
  const text = String(value ?? '');
  return /^[A-Za-z0-9_.-]+$/.test(text) && text !== '.' && text !== '..';
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// 「owner/repo」别名，供解析结果以 owner/repo 或 owner/name 两种方式读取。
// 非枚举属性不会影响 deepEqual / JSON 输出。
function aliasName(result, name) {
  try {
    Object.defineProperty(result, 'name', { value: name, enumerable: false });
    Object.defineProperty(result, 'full', {
      value: `${result.owner}/${name}`,
      enumerable: false,
    });
  } catch { /* 别名失败不影响主流程 */ }
  return result;
}

/**
 * 解析仓库标识：支持 `owner/repo`、API 的 repository_url
 * （https://api.github.com/repos/owner/repo）以及网页 URL。
 * 返回 { owner, repo }（另有非枚举的 name/full 别名），非法输入返回 null。
 */
export function parseRepo(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return null;
  let path = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      path = new URL(raw).pathname;
    } catch {
      return null;
    }
  }
  const parts = path.replace(/[?#].*$/, '').split('/').map(decodePathPart).filter(Boolean);
  if (parts.length < 2) return null;
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1].replace(/\.git$/i, '');
  if (!safePathPart(owner) || !safePathPart(repo)) return null;
  return aliasName({ owner, repo }, repo);
}

/** 相对时间：刚刚 / N 分钟前 / N 小时前 / N 天前 / 日期。 */
export function relativeTime(value, now = Date.now()) {
  const ts = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ts)) return '';
  const diff = Number(now) - ts;
  if (!Number.isFinite(diff) || diff < 60_000) return '刚刚';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const formatRelativeTime = relativeTime;

function clockHint(value) {
  const ts = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 把各种失败（HTTP 状态 / 网络 / GraphQL）翻译成简短中文提示。 */
export function friendlyGhError(error) {
  const status = typeof error === 'number' ? error : Math.trunc(Number(error?.status) || 0);
  const rawMessage = typeof error === 'string' ? error : String(error?.message || '');
  const message = rawMessage.replace(/^Error:\s*/, '').trim();
  const resetAt = typeof error === 'object' && error ? error.resetAt : null;

  if (error?.name === 'AbortError' || /abort(ed)?\b/i.test(message)) {
    return '请求超时或已取消，请重试';
  }
  if (status === 401) return 'Token 已失效（401），请重新连接 GitHub';
  if (status === 403) {
    const hint = clockHint(resetAt);
    if (/rate limit|secondary rate/i.test(message)) {
      return hint ? `GitHub API 限流，${hint} 后恢复` : 'GitHub API 限流，请稍后重试';
    }
    return hint
      ? `GitHub 拒绝访问（403），${hint} 后重试`
      : 'GitHub 拒绝访问（403），可能触发了限流，请稍后重试';
  }
  if (status === 404) return '资源不存在（404），请检查 Token 的仓库权限';
  if (status === 422) return '查询参数无效（422）';
  if (status === 429) {
    const hint = clockHint(resetAt);
    return hint ? `GitHub 限流，${hint} 后恢复` : 'GitHub 限流，请稍后重试';
  }
  if (status >= 500) return `GitHub 服务异常（${status}），请稍后重试`;
  if (Array.isArray(error?.errors) && error.errors.length) {
    const first = compactText(error.errors[0]?.message, 80) || '未知错误';
    return `GitHub 查询出错：${first}`;
  }
  if (/failed to fetch|network error|networkerror|load failed|fetch/i.test(message)) {
    return '网络不可用，请检查网络或代理后重试';
  }
  if (message) return `获取失败：${compactText(message, 80)}`;
  return '获取失败，请稍后重试';
}

/**
 * 生成 Search API 地址：review → review-requested:@me，mine → author:@me。
 * 其他值返回 null（CI 视图走 GraphQL）。
 */
export function buildSearchUrl(tab) {
  const query = tab === 'mine'
    ? 'is:open is:pr author:@me archived:false'
    : tab === 'review'
      ? 'is:open is:pr review-requested:@me archived:false'
      : '';
  if (!query) return null;
  return `${SEARCH_API}?q=${query.split(' ').join('+')}&sort=updated&order=desc&per_page=${MAX_ITEMS}`;
}

function safeGithubUrl(value, fallback = '') {
  const text = String(value ?? '').trim();
  if (!text) return fallback;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:') return fallback;
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return fallback;
    return url.href;
  } catch {
    return fallback;
  }
}

function makeGithubError(status, message, resetAt) {
  const err = new Error(message || (status ? `GitHub ${status}` : '请求失败'));
  err.status = Math.max(0, Math.trunc(Number(status) || 0));
  if (resetAt) err.resetAt = resetAt;
  return err;
}

/**
 * 归一化 Search API 的 issue/PR 条目。
 * 返回 { id, owner, repo, repoLabel, number, title, url, author, draft,
 * updatedAt, updatedLabel, state }，无法安全渲染时返回 null。
 */
export function normalizeSearchItem(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return null;
  const repo = parseRepo(raw.repository_url);
  if (!repo) return null;
  const number = Math.max(0, Math.trunc(Number(raw.number) || 0));
  const fallback = number ? `https://github.com/${repo.owner}/${repo.repo}/pull/${number}` : '';
  const url = safeGithubUrl(raw.html_url, fallback);
  if (!url) return null;
  const title = compactText(raw.title, MAX_TITLE) || '(无标题)';
  const author = compactText(raw.user?.login, 39);
  const updatedAt = String(raw.updated_at || '');
  const item = {
    id: `${repo.owner}/${repo.repo}#${number}`,
    owner: repo.owner,
    repo: repo.repo,
    repoLabel: `${repo.owner}/${repo.repo}`,
    number,
    title,
    url,
    author,
    draft: raw.draft === true,
    updatedAt,
    updatedLabel: relativeTime(updatedAt, now),
    state: '',
    stateLabel: '',
  };
  return aliasName(item, repo.repo);
}

/**
 * 从 GraphQL 的 pullRequests.nodes 中筛出 statusCheckRollup 为
 * FAILURE / ERROR 的 PR，字段与 normalizeSearchItem 保持一致。
 */
export function failedChecks(nodes, now = Date.now()) {
  const list = Array.isArray(nodes) ? nodes : [];
  const items = [];
  for (const node of list) {
    if (!node || typeof node !== 'object') continue;
    const state = compactText(node?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state).toUpperCase();
    if (state !== 'FAILURE' && state !== 'ERROR') continue;
    const repo = parseRepo(node?.repository?.nameWithOwner);
    if (!repo) continue;
    const number = Math.max(0, Math.trunc(Number(node.number) || 0));
    const fallback = number ? `https://github.com/${repo.owner}/${repo.repo}/pull/${number}` : '';
    const url = safeGithubUrl(node.url, fallback);
    if (!url) continue;
    const title = compactText(node.title, MAX_TITLE) || '(无标题)';
    const updatedAt = String(node.updatedAt || node.updated_at || '');
    const item = {
      id: `${repo.owner}/${repo.repo}#${number}`,
      owner: repo.owner,
      repo: repo.repo,
      repoLabel: `${repo.owner}/${repo.repo}`,
      number,
      title,
      url,
      author: '',
      draft: node.isDraft === true,
      updatedAt,
      updatedLabel: relativeTime(updatedAt, now),
      state,
      stateLabel: state === 'ERROR' ? '错误' : '失败',
    };
    items.push(aliasName(item, repo.repo));
    if (items.length >= MAX_ITEMS) break;
  }
  return items;
}

// ---------- 本地 Token 存储（chrome.storage.local，独立 key，不进 newtab_state） ----------

function storageArea() {
  try {
    if (typeof chrome === 'undefined') return null;
    return chrome?.storage?.local || null;
  } catch {
    return null;
  }
}

async function readStoredToken() {
  const area = storageArea();
  if (!area) return '';
  try {
    const got = await area.get(TOKEN_STORAGE_KEY);
    const value = got?.[TOKEN_STORAGE_KEY];
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

async function saveStoredToken(value) {
  const area = storageArea();
  if (!area) throw makeGithubError(0, '当前环境无法访问本地存储');
  await area.set({ [TOKEN_STORAGE_KEY]: value });
}

async function clearStoredToken() {
  const area = storageArea();
  if (!area) return;
  try {
    await area.remove(TOKEN_STORAGE_KEY);
  } catch { /* 清除失败不阻断界面回到未连接态 */ }
}

// ---------- 组件 ----------

export default {
  key: 'githubWorkbench',
  label: 'GitHub 工作台',
  description: '待我审 / 我的 PR / CI 失败三视图，Token 本地保存，支持键盘切换与 2 分钟缓存',
  defaultData: { tab: 'review' },
  config: [],

  init(container, data, api) {
    const el = document.createElement('div');
    el.className = 'mini-widget gw-widget';
    const uid = `gw-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    el.innerHTML = `
      <div class="mini-head">
        <span class="mini-icon" aria-hidden="true">${GITHUB_MARK}</span>
        <div class="mini-headtext">
          <div class="mini-title">GitHub 工作台</div>
          <div class="mini-sub" aria-live="polite">未连接</div>
        </div>
        <div class="mini-actions">
          <button type="button" class="mini-iconbtn" data-act="refresh" title="刷新" aria-label="刷新 GitHub 工作台">⟳</button>
          <button type="button" class="mini-iconbtn" data-act="account" title="账号与 Token" aria-label="账号与 Token 设置">⚙</button>
        </div>
      </div>
      <div class="gw-setup" hidden>
        <form class="mini-form" novalidate>
          <div class="mini-form-row">
            <input class="mini-input" type="password" name="github-token" autocomplete="off"
              autocapitalize="off" autocorrect="off" spellcheck="false"
              placeholder="ghp_… / github_pat_…" aria-label="GitHub Personal Access Token">
            <button type="submit" class="mini-btn mini-btn-primary">连接</button>
          </div>
          <p class="mini-hint">推荐使用 fine-grained、只读权限的 Token：Pull requests 与 Metadata 设为 Read 即可。</p>
          <p class="mini-warning">Token 只保存在本机 chrome.storage.local，不会写入新标签页状态，也不会显示在界面上；建议定期轮换。</p>
          <div class="gw-form-foot">
            <button type="button" class="mini-btn" data-act="cancel" hidden>取消</button>
            <button type="button" class="mini-btn" data-act="clear-token" hidden>清除已保存 Token</button>
          </div>
        </form>
        <p class="mini-hint gw-setup-msg" role="status" aria-live="polite" hidden></p>
      </div>
      <div class="gw-main" hidden>
        <div class="mini-tabs" role="tablist" aria-label="GitHub 工作台视图">
          ${WORKBENCH_TABS.map((tab) => `
            <button type="button" class="mini-tab gw-tab" role="tab" id="${uid}-${tab.key}"
              data-tab="${tab.key}" aria-controls="${uid}-panel" aria-selected="false" tabindex="-1">${tab.label}</button>
          `).join('')}
        </div>
        <div class="mini-list gw-list" id="${uid}-panel" role="tabpanel" aria-live="polite" aria-busy="true"></div>
      </div>
    `;
    container.appendChild(el);

    const subEl = el.querySelector('.mini-sub');
    const actionsEl = el.querySelector('.mini-actions');
    const refreshBtn = el.querySelector('[data-act="refresh"]');
    const setupEl = el.querySelector('.gw-setup');
    const mainEl = el.querySelector('.gw-main');
    const formEl = setupEl.querySelector('form');
    const inputEl = setupEl.querySelector('.mini-input');
    const submitBtn = setupEl.querySelector('button[type="submit"]');
    const cancelBtn = setupEl.querySelector('[data-act="cancel"]');
    const clearBtn = setupEl.querySelector('[data-act="clear-token"]');
    const setupMsgEl = setupEl.querySelector('.gw-setup-msg');
    const tabsEl = mainEl.querySelector('.mini-tabs');
    const listEl = mainEl.querySelector('.mini-list');
    const tabButtons = [...tabsEl.querySelectorAll('.mini-tab')];

    let destroyed = false;
    let token = '';
    let viewer = '';
    let active = WORKBENCH_TABS.some((tab) => tab.key === data.tab) ? data.tab : 'review';
    let counts = { review: null, mine: null, ci: null };
    let cache = new Map();
    let busy = false;
    let stale = false;
    let setupBusy = false;
    let requestSeq = 0;
    let controller = null;
    let timer = null;
    let setupController = null;
    let setupTimer = null;

    el.dataset.tab = active;

    function setHidden(node, hidden) {
      if (!node) return;
      node.hidden = hidden;
      // 防止组件样式覆盖 [hidden] 的默认 display:none，导致设置面板与主界面同时可见
      node.style.display = hidden ? 'none' : '';
    }

    function metaBitsOf(item) {
      const bits = [];
      if (item.author) bits.push(`@${item.author}`);
      if (item.updatedLabel) bits.push(item.updatedLabel);
      if (item.draft) bits.push('草稿');
      return bits;
    }

    function rowHtml(item) {
      const repoLabel = item.number ? `${item.repoLabel}#${item.number}` : item.repoLabel;
      const meta = metaBitsOf(item).join(' · ');
      const dot = `<span class="gw-dot ${item.state ? 'fail' : 'open'}" aria-hidden="true"></span>`;
      const badge = item.state
        ? `<span class="gw-badge" data-state="${escapeHtml(item.state)}" title="检查状态 ${escapeHtml(item.state)}">${escapeHtml(item.stateLabel || '失败')}</span>`
        : '';
      return `
        <a class="mini-row gw-row" href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer"
          title="${escapeHtml([repoLabel, item.title, meta].filter(Boolean).join('\n'))}">
          ${dot}
          <div class="gw-row-main">
            <div class="gw-repo">${escapeHtml(repoLabel)}</div>
            <div class="gw-row-title">${escapeHtml(item.title)}</div>
          </div>
          <div class="gw-row-meta">${escapeHtml(meta)}</div>
          ${badge}
        </a>`;
    }

    function emptyTextFor(tabKey) {
      const tab = WORKBENCH_TABS.find((item) => item.key === tabKey) || WORKBENCH_TABS[0];
      return tab.empty;
    }

    function syncTabs() {
      for (const btn of tabButtons) {
        const selected = btn.dataset.tab === active;
        btn.classList.toggle('active', selected);
        btn.setAttribute('aria-selected', String(selected));
        btn.tabIndex = selected ? 0 : -1;
      }
      listEl.setAttribute('aria-labelledby', `${uid}-${active}`);
      el.dataset.tab = active;
    }

    function syncSub() {
      if (!setupEl.hidden) return;
      const parts = [];
      if (viewer) parts.push(`@${viewer}`);
      if (Number.isFinite(counts.review)) {
        parts.push(`待审 ${counts.review}`);
      } else if (active === 'mine' && Number.isFinite(counts.mine)) {
        parts.push(`打开 ${counts.mine}`);
      } else if (active === 'ci' && Number.isFinite(counts.ci)) {
        parts.push(`CI 失败 ${counts.ci}`);
      }
      if (!parts.length) parts.push(busy ? '正在同步…' : 'GitHub 工作台');
      if (stale) parts.push('缓存');
      subEl.textContent = parts.join(' · ');
      subEl.title = viewer ? `已连接 GitHub 账号 @${viewer}` : '';
    }

    function setBusy(value) {
      busy = !!value;
      mainEl.setAttribute('aria-busy', busy ? 'true' : 'false');
      listEl.setAttribute('aria-busy', busy ? 'true' : 'false');
      refreshBtn.disabled = busy;
      refreshBtn.setAttribute('aria-busy', busy ? 'true' : 'false');
      syncSub();
    }

    function renderSkeleton() {
      stale = false;
      listEl.innerHTML = `
        <div class="gw-skeleton" aria-hidden="true">
          ${Array.from({ length: 3 }, () => `
            <div class="mini-row gw-row gw-sk">
              <span class="gw-dot"></span>
              <div class="gw-row-main">
                <div class="gw-repo"></div>
                <div class="gw-row-title"></div>
              </div>
            </div>`).join('')}
        </div>`;
      listEl.scrollTop = 0;
    }

    function renderEntries(entry) {
      stale = false;
      const items = Array.isArray(entry?.items) ? entry.items : [];
      if (!items.length) {
        listEl.innerHTML = `<div class="mini-state">${escapeHtml(emptyTextFor(entry?.tab))}</div>`;
        return;
      }
      listEl.innerHTML = items.map(rowHtml).join('');
      listEl.scrollTop = 0;
    }

    function renderError(err) {
      stale = false;
      const status = Math.trunc(Number(err?.status) || 0);
      listEl.innerHTML = `
        <div class="mini-state mini-state-error">
          <p class="gw-state-text">${escapeHtml(friendlyGhError(err))}</p>
          <div class="gw-state-actions">
            <button type="button" class="mini-btn" data-act="retry">重试</button>
            ${status === 401 ? '<button type="button" class="mini-btn" data-act="reconnect">重新连接</button>' : ''}
          </div>
        </div>`;
      listEl.scrollTop = 0;
    }

    function showMain() {
      setHidden(setupEl, true);
      setHidden(mainEl, false);
      setHidden(actionsEl, false);
      syncTabs();
      syncSub();
    }

    function setSetupMessage(message, isError = false) {
      setupMsgEl.textContent = message || '';
      setupMsgEl.dataset.error = isError ? 'true' : 'false';
      setHidden(setupMsgEl, !message);
    }

    function openSetup({ firstRun = false, message = '' } = {}) {
      setHidden(setupEl, false);
      setHidden(mainEl, true);
      setHidden(actionsEl, true);
      setHidden(cancelBtn, firstRun || !token);
      setHidden(clearBtn, !token);
      if (inputEl) inputEl.value = '';
      setSetupMessage(message, !!message);
      subEl.textContent = firstRun && !token ? '连接 GitHub 账号' : '账号与 Token';
      subEl.title = '';
      if (inputEl) inputEl.focus();
    }

    function setSetupBusy(value) {
      setupBusy = !!value;
      submitBtn.disabled = setupBusy;
      submitBtn.textContent = setupBusy ? '验证中…' : '连接';
      inputEl.disabled = setupBusy;
    }

    // ----- 请求与生命周期 -----

    function abortMain() {
      if (controller) {
        const ctrl = controller;
        controller = null;
        try {
          ctrl.abort();
        } catch { /* noop */ }
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function beginRequest() {
      abortMain();
      const seq = ++requestSeq;
      const ctrl = new AbortController();
      controller = ctrl;
      timer = setTimeout(() => {
        try {
          ctrl.abort();
        } catch { /* noop */ }
      }, REQUEST_TIMEOUT);
      return { ctrl, seq };
    }

    function endRequest(seq) {
      if (seq !== requestSeq) return false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      controller = null;
      return true;
    }

    function abortSetup() {
      if (setupController) {
        const ctrl = setupController;
        setupController = null;
        try {
          ctrl.abort();
        } catch { /* noop */ }
      }
      if (setupTimer) {
        clearTimeout(setupTimer);
        setupTimer = null;
      }
    }

    async function ghRequest(url, { signal, token: authToken, method = 'GET', body = null } = {}) {
      const headers = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${authToken || token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
      };
      const init = {
        method,
        signal,
        credentials: 'omit',
        cache: 'no-store',
        headers,
      };
      if (body) {
        headers['Content-Type'] = 'application/json';
        init.body = JSON.stringify(body);
      }
      let res;
      try {
        res = await fetch(url, init);
      } catch (err) {
        if (err?.name === 'AbortError') throw err;
        throw makeGithubError(0, 'network error');
      }
      if (!res.ok) {
        const resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000 || null;
        let detail = '';
        try {
          const payload = await res.json();
          detail = compactText(payload?.message, 160);
        } catch { /* 错误体不是 JSON 时只用状态码 */ }
        throw makeGithubError(res.status, detail || `GitHub ${res.status}`, resetAt);
      }
      try {
        return await res.json();
      } catch {
        throw makeGithubError(0, '响应不是合法的 JSON');
      }
    }

    async function fetchSearch(tabKey, signal) {
      const data = await ghRequest(buildSearchUrl(tabKey), { signal });
      const rows = Array.isArray(data?.items) ? data.items : [];
      const items = rows.map((item) => normalizeSearchItem(item)).filter(Boolean).slice(0, MAX_ITEMS);
      const total = Number(data?.total_count);
      return { items, count: Number.isFinite(total) && total >= 0 ? total : items.length };
    }

    async function fetchCI(signal) {
      const data = await ghRequest(GRAPHQL_API, {
        signal,
        method: 'POST',
        body: { query: CI_QUERY, variables: {} },
      });
      if (data && Array.isArray(data.errors) && data.errors.length) {
        const err = makeGithubError(0, 'GraphQL error');
        err.errors = data.errors;
        throw err;
      }
      const nodes = data?.data?.viewer?.pullRequests?.nodes;
      if (!Array.isArray(nodes)) throw makeGithubError(0, '响应缺少 pullRequests 数据');
      const items = failedChecks(nodes);
      return { items, count: items.length };
    }

    async function load({ force = false } = {}) {
      if (destroyed || !token) return;
      const tabKey = active;
      const cached = cache.get(tabKey);
      if (!force && cached && Date.now() - cached.at < CACHE_TTL) {
        requestSeq += 1;
        abortMain();
        renderEntries(cached);
        setBusy(false);
        return;
      }
      const { ctrl, seq } = beginRequest();
      if (cached) {
        renderEntries(cached);
      } else {
        renderSkeleton();
      }
      setBusy(true);
      try {
        const result = tabKey === 'ci'
          ? await fetchCI(ctrl.signal)
          : await fetchSearch(tabKey, ctrl.signal);
        if (destroyed || seq !== requestSeq) return;
        const entry = { tab: tabKey, items: result.items, count: result.count, at: Date.now() };
        cache.set(tabKey, entry);
        counts = { ...counts, [tabKey]: result.count };
        renderEntries(entry);
        syncSub();
      } catch (err) {
        if (destroyed || seq !== requestSeq) return;
        if (cached) {
          renderEntries(cached);
          stale = true;
          syncSub();
        } else {
          renderError(err);
        }
      } finally {
        if (endRequest(seq)) setBusy(false);
      }
    }

    function switchTab(nextKey, { focus = false } = {}) {
      const key = WORKBENCH_TABS.some((tab) => tab.key === nextKey) ? nextKey : 'review';
      const changed = key !== active;
      active = key;
      syncTabs();
      if (focus) {
        const btn = tabButtons.find((item) => item.dataset.tab === active);
        if (btn) btn.focus();
      }
      if (changed && typeof api?.patchWidget === 'function') api.patchWidget({ tab: active });
      syncSub();
      if (token) load();
    }

    function onTabsKeydown(e) {
      const total = WORKBENCH_TABS.length;
      const idx = WORKBENCH_TABS.findIndex((tab) => tab.key === active);
      let next = -1;
      if (e.key === 'ArrowRight') next = (idx + 1) % total;
      else if (e.key === 'ArrowLeft') next = (idx - 1 + total) % total;
      else if (e.key === 'Home') next = 0;
      else if (e.key === 'End') next = total - 1;
      else return;
      e.preventDefault();
      switchTab(WORKBENCH_TABS[next].key, { focus: true });
    }

    async function handleConnect(event) {
      if (event) event.preventDefault();
      if (destroyed || setupBusy) return;
      const raw = compactText(inputEl?.value, 400);
      if (!raw) {
        setSetupMessage('请先粘贴 GitHub Personal Access Token', true);
        if (inputEl) inputEl.focus();
        return;
      }
      if (/\s/.test(raw)) {
        setSetupMessage('Token 不能包含空格', true);
        return;
      }

      abortSetup();
      const ctrl = new AbortController();
      setupController = ctrl;
      setupTimer = setTimeout(() => {
        try {
          ctrl.abort();
        } catch { /* noop */ }
      }, REQUEST_TIMEOUT);
      setSetupBusy(true);
      setSetupMessage('正在验证 Token…', false);

      try {
        const me = await ghRequest(USER_API, { signal: ctrl.signal, token: raw });
        if (destroyed) return;
        const login = compactText(me?.login, 39);
        if (!login) throw makeGithubError(0, 'Token 无法读取 GitHub 账号');
        await saveStoredToken(raw);
        if (destroyed) return;
        token = raw;
        viewer = login;
        counts = { review: null, mine: null, ci: null };
        cache = new Map();
        stale = false;
        if (inputEl) inputEl.value = '';
        setSetupMessage('', false);
        setSetupBusy(false);
        showMain();
        renderSkeleton();
        await load({ force: true });
      } catch (err) {
        if (destroyed) return;
        const message = Number(err?.status) === 401
          ? 'Token 无效或已过期，请重新生成后再试'
          : friendlyGhError(err);
        setSetupMessage(message, true);
      } finally {
        abortSetup();
        setSetupBusy(false);
      }
    }

    async function handleClearToken() {
      if (destroyed) return;
      requestSeq += 1;
      abortMain();
      cache = new Map();
      counts = { review: null, mine: null, ci: null };
      stale = false;
      token = '';
      viewer = '';
      listEl.innerHTML = '';
      setBusy(false);
      await clearStoredToken();
      if (destroyed) return;
      openSetup({ firstRun: true, message: '已清除本地保存的 Token' });
    }

    function handleAccount() {
      if (destroyed) return;
      openSetup({ firstRun: !token });
    }

    function closestFrom(target, selector) {
      return target && typeof target.closest === 'function' ? target.closest(selector) : null;
    }

    function onClick(event) {
      const tabBtn = closestFrom(event.target, '.mini-tab');
      if (tabBtn) {
        switchTab(tabBtn.dataset.tab);
        return;
      }
      const actionEl = closestFrom(event.target, '[data-act]');
      const action = actionEl?.dataset?.act || '';
      if (!action) return;
      if (action === 'refresh') load({ force: true });
      else if (action === 'account') handleAccount();
      else if (action === 'retry') {
        if (token) load({ force: true });
      } else if (action === 'reconnect') handleAccount();
      else if (action === 'cancel') {
        if (token) showMain();
      } else if (action === 'clear-token') handleClearToken();
    }

    async function boot() {
      renderSkeleton();
      syncTabs();
      setBusy(true);
      token = await readStoredToken();
      if (destroyed) return;
      if (!token) {
        setBusy(false);
        openSetup({ firstRun: true });
        return;
      }
      showMain();
      const { ctrl, seq } = beginRequest();
      let fatal = null;
      try {
        const me = await ghRequest(USER_API, { signal: ctrl.signal });
        if (destroyed || seq !== requestSeq) return;
        viewer = compactText(me?.login, 39);
      } catch (err) {
        if (destroyed || seq !== requestSeq) return;
        if (err?.name === 'AbortError') return;
        fatal = err;
      }
      if (!endRequest(seq)) return;
      if (destroyed) return;
      if (Number(fatal?.status) === 401) {
        setBusy(false);
        renderError(fatal);
        syncSub();
        return;
      }
      syncSub();
      await load();
    }

    el.addEventListener('click', onClick);
    formEl.addEventListener('submit', handleConnect);
    tabsEl.addEventListener('keydown', onTabsKeydown);

    boot();

    return () => {
      destroyed = true;
      requestSeq += 1;
      abortMain();
      abortSetup();
      el.removeEventListener('click', onClick);
      formEl.removeEventListener('submit', handleConnect);
      tabsEl.removeEventListener('keydown', onTabsKeydown);
      if (el.parentNode) el.parentNode.removeChild(el);
    };
  },
};
