// widgets/devServices.js — 本地开发服务监控
// 通过 host permission 访问 localhost，展示端口/健康检查的在线状态与延迟。
// 不发启停命令：启停属于高权限操作，这里只做“看得见”的健康探测。

const PROBE_TIMEOUT = 4500;
const PROBE_EVERY = 60_000;
const PRESETS = [
  { name: 'Vite', url: 'http://localhost:5173' },
  { name: 'Java 学习台', url: 'http://localhost:4321' },
  { name: 'Ollama', url: 'http://localhost:11434/api/tags' },
  { name: 'LM Studio', url: 'http://localhost:1234/v1/models' },
];

function uid() {
  try { return crypto.randomUUID(); } catch { return `s-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function normalizeServices(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((item) => item && item.url).map((item) => ({
    id: String(item.id || uid()),
    name: String(item.name || item.url).slice(0, 32),
    url: String(item.url).slice(0, 500),
  }));
}

function labelForUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

function normalizeUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return '';
    return url.href;
  } catch {
    return '';
  }
}

async function probe(service, parentSignal) {
  const started = performance.now();
  const controller = new AbortController();
  const abortFromParent = () => controller.abort();
  parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT);
  try {
    const response = await fetch(service.url, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal,
      credentials: 'omit',
    });
    const ms = Math.round(performance.now() - started);
    return {
      state: response.status >= 500 ? 'warn' : 'up',
      status: response.status,
      ms,
    };
  } catch (err) {
    const ms = Math.round(performance.now() - started);
    return {
      state: 'down',
      status: 0,
      ms,
      message: err?.name === 'AbortError' ? '超时' : '未连接',
    };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener('abort', abortFromParent);
  }
}

export default {
  key: 'devServices',
  label: '开发服务台',
  description: '监控本地 Vite、Java 学习台、Ollama 等服务的端口与健康状态',
  defaultData: { services: [] },
  config: [],

  init(container, data, api) {
    const el = document.createElement('div');
    el.className = 'mini-widget ds-widget';
    el.innerHTML = `
      <div class="mini-head">
        <span class="mini-icon ds-icon" aria-hidden="true">▣</span>
        <div class="mini-copy">
          <div class="mini-title">开发服务</div>
          <div class="mini-sub">本地端口 · 健康探测</div>
        </div>
        <div class="mini-actions">
          <button type="button" class="mini-iconbtn ds-add" title="添加服务" aria-label="添加服务">＋</button>
          <button type="button" class="mini-iconbtn ds-refresh" title="刷新状态" aria-label="刷新状态">↻</button>
        </div>
      </div>
      <div class="ds-body"></div>
    `;
    container.appendChild(el);

    const bodyEl = el.querySelector('.ds-body');
    const subEl = el.querySelector('.mini-sub');
    const addBtn = el.querySelector('.ds-add');
    const refreshBtn = el.querySelector('.ds-refresh');
    let services = normalizeServices(data.services);
    const results = new Map();
    let pollTimer = 0;
    let inFlight = null;
    let destroyed = false;
    let formOpen = false;

    function save() {
      if (!destroyed) api.patchWidget({ services });
    }

    function setSub(text, title = '') {
      subEl.textContent = text;
      subEl.title = title;
    }

    function onlineCount() {
      return services.filter((s) => ['up', 'warn'].includes(results.get(s.id)?.state)).length;
    }

    function render() {
      formOpen = false;
      bodyEl.innerHTML = '';
      if (!services.length) {
        const empty = document.createElement('div');
        empty.className = 'mini-state ds-empty';
        empty.innerHTML = `
          <div>还没有监控服务</div>
          <div class="ds-presets">
            ${PRESETS.map((p, i) => `<button type="button" class="ds-preset" data-preset="${i}">＋ ${escapeHtml(p.name)}</button>`).join('')}
          </div>
        `;
        bodyEl.appendChild(empty);
        setSub('本地端口 · 健康探测');
        empty.addEventListener('click', (event) => {
          const btn = event.target.closest('[data-preset]');
          if (!btn) return;
          const preset = PRESETS[Number(btn.dataset.preset)];
          if (preset) addPreset(preset);
        });
        return;
      }

      setSub(`${onlineCount()}/${services.length} 在线 · 60s 刷新`);
      const list = document.createElement('div');
      list.className = 'mini-list ds-list';
      list.innerHTML = services.map((service) => {
        const result = results.get(service.id) || { state: 'checking' };
        const stateText = result.state === 'checking' ? '探测中'
          : result.state === 'down' ? (result.message || '未连接')
            : `${result.status || 'OK'} · ${result.ms}ms`;
        return `
          <div class="mini-row ds-row" data-id="${escapeHtml(service.id)}">
            <span class="ds-dot ${result.state}" aria-hidden="true"></span>
            <span class="ds-main">
              <a class="ds-name" href="${escapeHtml(service.url)}" target="_blank" rel="noopener noreferrer" title="${escapeHtml(service.url)}">${escapeHtml(service.name)}</a>
              <span class="ds-meta">${escapeHtml(labelForUrl(service.url))}</span>
            </span>
            <span class="ds-status ${result.state}" title="${escapeHtml(result.message || service.url)}">${escapeHtml(stateText)}</span>
            <button type="button" class="ds-del" title="移除" aria-label="移除 ${escapeHtml(service.name)}">×</button>
          </div>
        `;
      }).join('');
      bodyEl.appendChild(list);

      list.addEventListener('click', (event) => {
        const row = event.target.closest('.ds-row');
        if (!row) return;
        if (event.target.closest('.ds-del')) {
          const service = services.find((s) => s.id === row.dataset.id);
          if (!service || !confirm(`移除「${service.name}」？`)) return;
          services = services.filter((s) => s.id !== row.dataset.id);
          results.delete(row.dataset.id);
          save();
          render();
        }
      });
    }

    function addPreset(preset) {
      if (services.some((s) => s.url === preset.url)) {
        setSub('已经添加过这个地址');
        return;
      }
      services = [...services, { id: uid(), name: preset.name, url: preset.url }];
      save();
      probeAll();
    }

    function openForm() {
      formOpen = true;
      bodyEl.innerHTML = `
        <form class="mini-form ds-form">
          <div class="mini-form-row">
            <input class="mini-input ds-name-input" maxlength="32" placeholder="服务名，例如 Vite" autocomplete="off" />
          </div>
          <div class="mini-form-row">
            <input class="mini-input ds-url-input" placeholder="http://localhost:5173" autocomplete="off" spellcheck="false" />
          </div>
          <div class="ds-form-actions">
            <button type="button" class="mini-btn ds-cancel">取消</button>
            <button type="submit" class="mini-btn mini-btn-primary">添加</button>
          </div>
          <div class="mini-hint">只探测，不执行启停；需要 localhost 访问权限。</div>
        </form>
      `;
      const form = bodyEl.querySelector('.ds-form');
      const nameInput = form.querySelector('.ds-name-input');
      const urlInput = form.querySelector('.ds-url-input');
      nameInput.focus();
      setSub('添加本地服务');
      form.querySelector('.ds-cancel').addEventListener('click', render);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const url = normalizeUrl(urlInput.value);
        if (!url) {
          setSub('请输入 http:// 或 https:// 地址');
          urlInput.focus();
          return;
        }
        if (services.some((s) => s.url === url)) {
          setSub('这个地址已经在监控列表里');
          return;
        }
        const name = nameInput.value.trim() || labelForUrl(url);
        services = [...services, { id: uid(), name: name.slice(0, 32), url }];
        save();
        render();
        probeAll();
      });
    }

    async function probeAll() {
      if (destroyed || formOpen || !services.length) return;
      if (inFlight) {
        try { inFlight.abort(); } catch { /* ignore */ }
      }
      const controller = new AbortController();
      inFlight = controller;
      for (const service of services) results.set(service.id, { state: 'checking' });
      render();

      const jobs = services.map(async (service) => {
        const result = await probe(service, controller.signal);
        if (!destroyed && inFlight === controller) {
          results.set(service.id, result);
          render();
        }
      });
      await Promise.all(jobs);
      if (inFlight === controller) inFlight = null;
    }

    function startPoll() {
      clearInterval(pollTimer);
      pollTimer = setInterval(() => {
        if (document.visibilityState === 'visible') probeAll();
      }, PROBE_EVERY);
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') probeAll();
    }

    addBtn.addEventListener('click', openForm);
    refreshBtn.addEventListener('click', () => probeAll());
    document.addEventListener('visibilitychange', onVisibility);
    startPoll();
    render();
    probeAll();

    return () => {
      destroyed = true;
      clearInterval(pollTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (inFlight) {
        try { inFlight.abort(); } catch { /* ignore */ }
      }
      inFlight = null;
    };
  },
};
