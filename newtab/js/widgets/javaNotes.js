// widgets/javaNotes.js — 「Java 终极笔记 · 学习台」2×1 小组件
// 数据链路：本页 --ai:subscribe--> SW --Native Messaging--> ai_manager_host
// 一键启动/停止/构建/备份都由 host 执行；页面只发命令、展示状态。
// 设计：状态感知的主按钮 + 三项学习数据 + 四个高频入口；管理弹层放服务详情/日志。

import { placePopover } from './popover.js';

const SITE_BASE = 'http://127.0.0.1:4321';
const ROUTES = {
  review: '/review',
  hot200: '/hot200',
  project: '/project',
  source: '/project/source/graph',
};

const ROUTE_LABELS = {
  '/': '首页',
  '/review': '今日复习',
  '/hot200': 'Hot200',
  '/project': '项目',
  '/project/source': '源码图谱',
  '/project/source/graph': '源码图谱',
  '/mysql': 'MySQL',
  '/mw': '中间件',
  '/ai': 'AI',
  '/frontend': '前端',
  '/train': '训练',
  '/search': '全站搜索',
  '/freq': '考频',
  '/apply': '投递',
  '/resume': '简历',
};

const COMMAND_TIMEOUT = {
  start: 20_000,
  stop: 30_000,
  restart: 35_000,
  build: 20_000,
  backup: 70_000,
  logs: 15_000,
  refresh: 15_000,
};

function routeLabel(pathname) {
  if (!pathname) return '';
  const clean = String(pathname).split('?')[0].replace(/\/+$/, '') || '/';
  return ROUTE_LABELS[clean] || clean;
}

function formatMinutes(ms) {
  const min = Math.max(0, Math.round((Number(ms) || 0) / 60_000));
  if (min < 60) return `${min} 分钟`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function relativeTime(ts, now = Date.now()) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const diff = Math.max(0, now - t);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

function normalizeRootPath(value) {
  return String(value || '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\//g, '\\')
    .replace(/\\+$/, '')
    .toLowerCase();
}

export default {
  key: 'javaNotes',
  label: 'Java 终极笔记 · 学习台',
  description: '一键启动 Java 终极笔记，查看今日复习、学习位置、批注与服务状态',
  defaultData: { root: '', autoFallback: true },
  config: [
    {
      key: 'root',
      label: '启动目录',
      type: 'text',
      default: '',
      placeholder: '留空自动检测；例如 D:\\work\\Java终极笔记',
      hint: '必须是项目根目录（直接包含 start.ps1 和 site/package.json）。支持 %USERPROFILE%、~ 和环境变量；留空会自动探测。',
    },
    {
      key: 'autoFallback',
      label: '目录失效时自动检测',
      type: 'bool',
      default: true,
      hint: '配置目录不存在或不完整时，自动在用户目录下寻找包含 start.ps1 和 site/package.json 的项目。',
    },
  ],

  init(container, data, api) {
    const el = document.createElement('div');
    el.className = 'jn-widget';
    el.innerHTML = `
      <div class="jn-top">
        <div class="jn-brand">
          <div class="jn-logo" aria-hidden="true">J</div>
          <div class="jn-brand-text">
            <div class="jn-name">Java 终极笔记</div>
            <div class="jn-statusline">
              <span class="jn-status" data-svc="site"><i class="jn-dot"></i><span class="jn-status-label">站点</span></span>
              <span class="jn-status" data-svc="anno"><i class="jn-dot"></i><span class="jn-status-label">批注</span></span>
              <span class="jn-detail" data-k="detail" aria-live="polite">正在连接…</span>
            </div>
          </div>
        </div>
        <div class="jn-top-actions">
          <button type="button" class="jn-primary" data-k="primary">启动并学习</button>
          <button type="button" class="jn-more" data-k="more" title="服务管理" aria-label="服务管理">⋯</button>
        </div>
      </div>
      <div class="jn-metrics">
        <div class="jn-metric" title="今天的复习记录">
          <span class="jn-metric-num" data-k="review">—</span>
          <span class="jn-metric-label">今日复习</span>
        </div>
        <div class="jn-metric" title="本地记录的学习时长">
          <span class="jn-metric-num" data-k="minutes">—</span>
          <span class="jn-metric-label">已记录时长</span>
        </div>
        <div class="jn-metric" title="批注页数 / 条数">
          <span class="jn-metric-num" data-k="annos">—</span>
          <span class="jn-metric-label">批注数</span>
        </div>
      </div>
      <div class="jn-continue">
        <span class="jn-cont-label">上次</span>
        <button type="button" class="jn-cont-path" data-k="continue" title="继续上次学习">暂无学习记录</button>
      </div>
      <div class="jn-links">
        <button type="button" class="jn-link" data-route="${ROUTES.review}">今日复习</button>
        <button type="button" class="jn-link" data-route="${ROUTES.hot200}">Hot200</button>
        <button type="button" class="jn-link" data-route="${ROUTES.project}">项目</button>
        <button type="button" class="jn-link" data-route="${ROUTES.source}">源码图谱</button>
      </div>
    `;
    container.appendChild(el);

    const refs = {
      detail: el.querySelector('[data-k="detail"]'),
      primary: el.querySelector('[data-k="primary"]'),
      more: el.querySelector('[data-k="more"]'),
      review: el.querySelector('[data-k="review"]'),
      minutes: el.querySelector('[data-k="minutes"]'),
      annos: el.querySelector('[data-k="annos"]'),
      continueBtn: el.querySelector('[data-k="continue"]'),
      site: el.querySelector('[data-svc="site"]'),
      anno: el.querySelector('[data-svc="anno"]'),
    };

    const projectRoot = String(data?.root || '').trim();
    const autoFallback = data?.autoFallback !== false;
    let current = null;
    let port = null;
    let disposed = false;
    let reconnectTimer = null;
    let watchRetryTimer = null;
    let reconnectDelay = 1000;
    let hostError = '';
    let uiError = '';
    let uiErrorTimer = null;
    let pending = new Map();
    let openWhenSiteReady = '';
    let opening = false;
    let popover = null;
    let popActionBusy = false;
    let firstStateTimer = setTimeout(() => {
      if (current || disposed) return;
      hostError = '未收到项目状态，重启扩展/浏览器后再试';
      render();
    }, 25_000);

    function applyState(next) {
      if (!next || typeof next !== 'object') return;
      // 多个学习台指向不同目录时，只认自己配置的目录；没配置时接受 host
      // 自动探测/环境变量/默认目录解析出的 root，不要拿 defaultRoot 强行过滤。
      // %VAR%/~ 由 host 展开，这里不做字符串比较，避免误判。
      if (projectRoot && next.root && !/[%]/.test(projectRoot) && !projectRoot.startsWith('~')) {
        const expectedRoot = next.requestedRoot || projectRoot;
        if (normalizeRootPath(next.root) !== normalizeRootPath(expectedRoot)) return;
      }
      clearTimeout(firstStateTimer);
      hostError = '';
      const prev = current;
      current = next;
      uiError = '';
      render();
      if (openWhenSiteReady && next.site?.ok && !next.site.foreign && !opening) {
        const target = openWhenSiteReady;
        openWhenSiteReady = '';
        openRoute(target);
      }
      if (popover) renderPopover();
      // 状态从启动中回到 running_site_only/full 时，管理弹层里的按钮解除禁用
      if (prev?.state === 'starting' && next.state !== 'starting' && popover) renderPopover();
    }

    function statusClass(svc) {
      if (!svc) return 'off';
      if (svc.foreign) return 'warn';
      if (svc.ok) return 'ok';
      if (svc.portOpen) return 'warn';
      return 'off';
    }

    function primaryView() {
      const s = current;
      if (!s) return { label: '启动并学习', cls: '', disabled: false };
      if (s.state === 'starting' || s.state === 'stopping') {
        return { label: s.state === 'stopping' ? '停止中…' : '启动中…', cls: 'busy', disabled: true };
      }
      if (s.state === 'running_full') return { label: '打开学习', cls: 'ready', disabled: false };
      if (s.state === 'running_site_only') return { label: '补启批注', cls: 'warn', disabled: false };
      // 端口冲突/host 离线时不要用 disabled 按钮“静默”：点击后给出具体原因，
      // 否则用户看到的就是“点了完全没反应”。真正启动/停止中才禁用。
      if (s.state === 'port_conflict') return { label: '端口被占用', cls: 'danger', disabled: false };
      if (s.state === 'error') return { label: '重试', cls: 'warn', disabled: false };
      return { label: '启动并学习', cls: '', disabled: false };
    }

    function detailText() {
      if (uiError) return uiError;
      if (hostError) return hostError;
      const s = current;
      if (!s) return '正在读取项目状态…';
      if (s.state === 'starting') return s.message || '正在启动…';
      if (s.state === 'stopping') return '正在停止…';
      if (s.state === 'running_full') return '站点与批注已就绪';
      if (s.state === 'running_site_only') return '批注离线 · 阅读可用，统计为本地快照';
      if (s.state === 'port_conflict') return '4321 被其他程序占用';
      if (s.state === 'error') return s.lastError?.message || '启动失败';
      if (s.state === 'stopped') return '本地站点未启动';
      return s.message || '正在读取项目状态…';
    }

    function render() {
      const s = current;
      const p = primaryView();
      el.dataset.state = s?.state || 'unknown';
      refs.primary.textContent = p.label;
      refs.primary.disabled = p.disabled;
      refs.primary.className = `jn-primary${p.cls ? ' ' + p.cls : ''}`;
      refs.primary.setAttribute('aria-busy', p.cls === 'busy' ? 'true' : 'false');
      refs.detail.textContent = detailText();
      refs.detail.title = [detailText(), s?.rootWarning].filter(Boolean).join(' · ');

      const siteState = statusClass(s?.site);
      const annoState = statusClass(s?.anno);
      refs.site.dataset.state = siteState;
      refs.anno.dataset.state = annoState;
      refs.site.title = s?.site
        ? `站点 ${s.site.port}${s.site.foreign ? ' 被其他程序占用' : (s.site.ok ? ' 运行中' : (s.site.portOpen ? ' 端口占用' : ' 未启动'))}`
        : '站点状态';
      refs.anno.title = s?.anno ? `批注 ${s.anno.port}${s.anno.ok ? ' 运行中' : (s.anno.portOpen ? ' 端口占用' : ' 未启动')}` : '批注服务状态';

      const learning = s?.learning;
      const usable = !!learning?.ok;
      const stale = usable && !learning.live;
      for (const key of ['review', 'minutes', 'annos']) {
        refs[key].classList.toggle('stale', stale);
      }
      refs.review.textContent = usable ? String(learning.todayReview || 0) : '—';
      refs.minutes.textContent = usable ? formatMinutes(learning.totalMs) : '—';
      refs.annos.textContent = usable ? String(learning.annotations || 0) : '—';
      refs.review.title = usable
        ? `今日复习 ${learning.todayReview || 0} 题${stale ? '（批注服务离线，本地快照）' : ''}`
        : '批注服务离线，暂无学习数据';
      refs.minutes.title = usable
        ? `累计 ${formatMinutes(learning.totalMs)} · ${learning.totalVisits || 0} 次访问${stale ? '（本地快照）' : ''}`
        : '批注服务离线，暂无学习数据';
      refs.annos.title = usable
        ? `${learning.annotationPages || 0} 页 / ${learning.annotations || 0} 条${stale ? '（本地快照）' : ''}`
        : '批注服务离线，暂无学习数据';

      const route = learning?.lastPath || '';
      refs.continueBtn.textContent = route
        ? (route === '/' ? '首页' : `${routeLabel(route)} · ${route}`)
        : '暂无学习记录';
      refs.continueBtn.disabled = !route;
      refs.continueBtn.dataset.route = route || '';
      refs.continueBtn.title = route ? `继续 ${route}` : '还没有可继续的学习记录';

      const starting = s?.state === 'starting' || s?.state === 'stopping';
      el.querySelectorAll('.jn-link').forEach((btn) => {
        // 站点已经在跑时，host 离线也不该挡住只读导航。
        btn.disabled = starting || (!!hostError && !s?.site?.ok);
      });
    }

    function setUiError(message) {
      uiError = String(message || '操作失败');
      clearTimeout(uiErrorTimer);
      uiErrorTimer = setTimeout(() => {
        uiError = '';
        render();
      }, 6500);
      render();
    }

    function errorText(e) {
      const message = e?.message || '启动失败';
      const detail = String(e?.detail || '').replace(/\s+/g, ' ').trim();
      return detail && !message.includes(detail) ? `${message}（${detail.slice(0, 180)}）` : message;
    }

    function openRoute(route) {
      const path = route && String(route).startsWith('/') ? route : '/';
      const url = `${SITE_BASE}${path}`;
      try {
        chrome.tabs.create({ url, active: true });
      } catch {
        window.open(url, '_blank', 'noopener');
      }
    }

    function openRouteWhenReady(route) {
      if (current?.site?.ok && !current.site.foreign) {
        openRoute(route);
        return;
      }
      if (current?.state === 'port_conflict') {
        setUiError('4321 被其他程序占用，不能打开本地站点');
        return;
      }
      openWhenSiteReady = route;
      if (current?.state !== 'starting') {
        command('start', { withAnno: true }).catch((e) => {
          openWhenSiteReady = '';
          setUiError(errorText(e));
        });
      }
    }

    // ---- 与 host 的命令通道 ----
    function sendWatch(watch) {
      const message = {
        action: 'project:watch',
        watch,
        root: projectRoot,
        autoFallback,
      };
      // 先用一次性消息唤醒 SW；长连接端口只负责接收推送，不承担上行。
      // 老版本后台不认 project:watch 时，再退回端口发送。
      try {
        chrome.runtime.sendMessage(message, () => {
          const err = chrome.runtime.lastError;
          if (err && port) {
            try { port.postMessage(message); } catch {}
          }
        });
      } catch {
        if (port) {
          try { port.postMessage(message); } catch {}
        }
      }
    }

    function connect() {
      if (disposed || port) return;
      try {
        port = chrome.runtime.connect({ name: 'ai:subscribe' });
      } catch (e) {
        hostError = '无法连接扩展后台';
        render();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(connect, 1500);
        return;
      }
      port.onMessage.addListener((m) => {
        if (!m || m.action !== 'ai:event') return;
        onEvent(m.payload);
      });
      port.onDisconnect.addListener(() => {
        port = null;
        if (disposed) return;
        hostError = 'host 未连接（是否已运行 install-host.bat？）';
        render();
        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(() => {
          reconnectDelay = Math.min(reconnectDelay * 2, 15_000);
          connect();
        }, reconnectDelay);
      });
      // 把组件配置的目录告诉 background/host；background 会在 host
      // 重连和页面重开时用同一个目录恢复监控。
      sendWatch(true);
    }

    function onEvent(ev) {
      if (!ev || !ev.type) return;
      switch (ev.type) {
        case 'snapshot':
          hostError = '';
          reconnectDelay = 1000;
          if (ev.javaNotes) applyState(ev.javaNotes);
          else render();
          break;
        case 'project:state':
          hostError = '';
          reconnectDelay = 1000;
          applyState(ev.state || ev);
          break;
        case 'project:result': {
          const entry = pending.get(ev.requestId);
          if (!entry) break;
          pending.delete(ev.requestId);
          clearTimeout(entry.timer);
          if (ev.ok) entry.resolve(ev);
          else entry.reject(Object.assign(new Error(ev.error?.message || '操作失败'), {
            code: ev.error?.code || 'project_command_failed',
            detail: ev.error?.detail || '',
          }));
          break;
        }
        case 'host:ready':
          hostError = '';
          render();
          break;
        case 'host:error':
          hostError = ev.message || 'host 未连接';
          render();
          break;
        default:
          break;
      }
    }

    function command(name, payload = {}) {
      const requestId = (crypto?.randomUUID?.())
        || `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const timeout = COMMAND_TIMEOUT[name] || 20_000;
      return new Promise((resolve, reject) => {
        let settled = false;
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          fn(value);
        };
        const timer = setTimeout(() => {
          finish(reject, new Error('host 响应超时'));
        }, timeout);
        // 用一次性消息而不是页面长连接：SW 被回收/页面端口半死时，
        // sendMessage 仍能唤醒 SW 并把命令转给 host。
        try {
          chrome.runtime.sendMessage({
            action: 'project:command',
            requestId,
            root: projectRoot,
            autoFallback,
            command: name,
            payload,
          }, (resp) => {
            const err = chrome.runtime.lastError;
            if (err) {
              finish(reject, new Error(err.message || '扩展后台不可用，请重新加载扩展'));
              return;
            }
            if (!resp) {
              finish(reject, new Error('扩展后台未响应，请重新加载扩展'));
              return;
            }
            if (resp.ok) finish(resolve, resp);
            else {
              finish(reject, Object.assign(new Error(resp.error?.message || '操作失败'), {
                code: resp.error?.code || 'project_command_failed',
                detail: resp.error?.detail || '',
              }));
            }
          });
        } catch (e) {
          finish(reject, new Error(String(e?.message || e)));
        }
      });
    }

    function startAndMaybeOpen(route = '/') {
      if (current?.state === 'starting' || current?.state === 'stopping') return;
      openWhenSiteReady = route;
      // 立刻给点击反馈；host 正常会很快推 starting/结果，applyState 会清掉提示。
      setUiError('正在请求 host 启动…');
      command('start', { withAnno: true })
        .then((res) => {
          if (res?.state) applyState(res.state);
          else render();
          if (res?.state?.site?.ok && !res.state.site.foreign && openWhenSiteReady) {
            const target = openWhenSiteReady;
            openWhenSiteReady = '';
            openRoute(target);
          }
        })
        .catch((e) => {
          openWhenSiteReady = '';
          setUiError(errorText(e));
        });
    }

    function onPrimary() {
      const s = current;
      // 初始快照还没回来时也允许直接启动；host 会做完整的端口/归属检查。
      if (!s) { startAndMaybeOpen('/'); return; }
      if (s.state === 'starting' || s.state === 'stopping') return;
      if (s.state === 'running_full') {
        openRoute('/');
        return;
      }
      if (s.state === 'running_site_only') {
        startAndMaybeOpen('/');
        return;
      }
      if (s.state === 'port_conflict') {
        setUiError(`端口 ${s.site?.port || 4321} 被其他程序占用；请先停止旧目录服务或释放端口`);
        return;
      }
      if (hostError && !port) {
        setUiError('host 未连接，请重启扩展/浏览器后再试');
        return;
      }
      startAndMaybeOpen('/');
    }

    refs.primary.addEventListener('click', onPrimary);
    refs.continueBtn.addEventListener('click', () => {
      const route = refs.continueBtn.dataset.route;
      if (route) openRouteWhenReady(route);
    });
    el.querySelectorAll('.jn-link').forEach((btn) => {
      btn.addEventListener('click', () => openRouteWhenReady(btn.dataset.route || '/'));
    });
    refs.more.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePopover();
    });

    // ---- 管理弹层：服务详情 + 日志 + 重启/停止/构建/备份 ----
    function togglePopover() {
      if (popover) { closePopover(); return; }
      openPopover();
    }

    function openPopover() {
      popover = document.createElement('div');
      popover.className = 'jn-popover';
      popover.innerHTML = `
        <div class="jn-pop-head">
          <div>
            <div class="jn-pop-title">Java 笔记 · 服务管理</div>
            <div class="jn-pop-sub" data-k="checked">本地学习台</div>
          </div>
          <button type="button" class="jn-pop-close" data-k="close" title="关闭">✕</button>
        </div>
        <div class="jn-pop-root" data-k="root"></div>
        <div class="jn-services">
          <div class="jn-service" data-svc="site">
            <span class="jn-dot"></span>
            <span class="jn-service-name">站点 4321</span>
            <span class="jn-service-state" data-k="site-state">—</span>
            <span class="jn-service-pid" data-k="site-pid"></span>
          </div>
          <div class="jn-service" data-svc="anno">
            <span class="jn-dot"></span>
            <span class="jn-service-name">批注 4400</span>
            <span class="jn-service-state" data-k="anno-state">—</span>
            <span class="jn-service-pid" data-k="anno-pid"></span>
          </div>
        </div>
        <div class="jn-pop-actions">
          <button type="button" class="jn-pop-action" data-act="restart">重启</button>
          <button type="button" class="jn-pop-action danger" data-act="stop">停止</button>
          <button type="button" class="jn-pop-action" data-act="build">构建预览</button>
          <button type="button" class="jn-pop-action" data-act="backup">导出备份</button>
          <button type="button" class="jn-pop-action" data-act="logs">刷新日志</button>
        </div>
        <div class="jn-pop-note" data-k="note"></div>
        <div class="jn-log-head"><span>最近日志</span><span class="jn-log-hint">site.log · anno.log</span></div>
        <pre class="jn-log" data-k="logs">打开后加载…</pre>
      `;
      document.body.appendChild(popover);
      placePopover(popover, refs.more, {
        width: Math.min(410, window.innerWidth - 16),
        offsetY: 8,
        reserveH: Math.min(390, window.innerHeight - 16),
      });
      popover.addEventListener('click', onPopoverClick);
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', onKeydown);
      window.addEventListener('resize', onPopoverResize, { once: true });
      renderPopover();
      loadLogs();
      popover.querySelector('.jn-pop-close')?.focus({ preventScroll: true });
    }

    function closePopover() {
      if (!popover) return;
      document.removeEventListener('click', onDocClick, true);
      document.removeEventListener('keydown', onKeydown);
      window.removeEventListener('resize', onPopoverResize);
      popover.remove();
      popover = null;
    }

    function onPopoverResize() {
      closePopover();
    }

    function onDocClick(e) {
      if (!popover) return;
      if (popover.contains(e.target) || refs.more.contains(e.target)) return;
      closePopover();
    }

    function onKeydown(e) {
      if (e.key === 'Escape') closePopover();
    }

    function popoverNote(text, kind = '') {
      if (!popover) return;
      const note = popover.querySelector('[data-k="note"]');
      note.textContent = text || '';
      note.className = `jn-pop-note${kind ? ' ' + kind : ''}`;
    }

    function renderPopover() {
      if (!popover) return;
      const s = current || {};
      const site = s.site || {};
      const anno = s.anno || {};
      const siteState = site.ok ? '运行中' : (site.portOpen ? '端口占用' : '未启动');
      const annoState = anno.ok ? '运行中' : (anno.portOpen ? '端口占用' : '未启动');
      popover.querySelector('[data-k="site-state"]').textContent = siteState;
      popover.querySelector('[data-k="anno-state"]').textContent = annoState;
      popover.querySelector('[data-k="site-pid"]').textContent = site.pid ? `pid ${site.pid}` : '';
      popover.querySelector('[data-k="anno-pid"]').textContent = anno.pid ? `pid ${anno.pid}` : '';
      popover.querySelector('[data-svc="site"]').dataset.state = statusClass(site);
      popover.querySelector('[data-svc="anno"]').dataset.state = statusClass(anno);
      const rootEl = popover.querySelector('[data-k="root"]');
      const shownRoot = s.root || projectRoot || '自动检测';
      const sourceLabel = {
        configured: '配置目录',
        env: 'JAVA_NOTES_ROOT',
        default: '默认目录',
        auto: '自动检测',
        fallback: '自动备用',
      }[s.rootSource] || '';
      rootEl.textContent = `目录：${shownRoot}${sourceLabel ? ` · ${sourceLabel}` : ''}`;
      rootEl.title = s.rootWarning || shownRoot;
      rootEl.classList.toggle('warn', !!s.rootWarning);
      const checked = s.checkedAt ? `更新于 ${relativeTime(s.checkedAt)}` : '等待状态';
      const learning = s.learning;
      const dataNote = learning?.ok
        ? `学习数据：${learning.live ? '批注服务实时' : '本地文件快照'}`
        : '学习数据：暂无';
      popover.querySelector('[data-k="checked"]').textContent = `${checked} · ${dataNote}`;
      const busy = s.state === 'starting' || s.state === 'stopping';
      popover.querySelectorAll('.jn-pop-action').forEach((btn) => {
        btn.disabled = busy || popActionBusy || (btn.dataset.act === 'stop' && s.state === 'stopped');
      });
    }

    async function loadLogs() {
      if (!popover) return;
      const pre = popover.querySelector('[data-k="logs"]');
      pre.textContent = '加载中…';
      try {
        const res = await command('logs', { tail: 80 });
        if (pre.isConnected) pre.textContent = res.text || '暂无日志';
        if (pre.isConnected) pre.scrollTop = pre.scrollHeight;
      } catch (e) {
        if (pre.isConnected) pre.textContent = `读取失败：${e?.message || e}`;
      }
    }

    async function runPopAction(action) {
      if (!popover || popActionBusy) return;
      if (action === 'logs') { loadLogs(); return; }
      if (action === 'stop' && !confirm('停止 Java 笔记的本地站点和批注服务？')) return;
      if (action === 'restart' && !confirm('重启 Java 笔记本地服务？')) return;
      if (action === 'build' && !confirm('重新构建并启动生产预览？约 30–60 秒，期间站点会短暂停止。')) return;

      popActionBusy = true;
      renderPopover();
      const labels = { restart: '正在重启…', stop: '正在停止…', build: '正在构建…', backup: '正在导出…' };
      popoverNote(labels[action] || '处理中…');
      try {
        const res = await command(action, { withAnno: true });
        if (action === 'backup') {
          const size = res.size ? ` (${Math.max(1, Math.round(res.size / 1024))} KB)` : '';
          popoverNote(`备份完成：${res.path || '已导出'}${size}`, 'ok');
        } else {
          if (res.state) applyState(res.state);
          popoverNote(res.message || '操作已提交');
          if (action === 'logs' || action === 'build' || action === 'restart') loadLogs();
        }
      } catch (e) {
        popoverNote(e?.message || '操作失败', 'error');
      } finally {
        popActionBusy = false;
        if (popover) renderPopover();
      }
    }

    function onPopoverClick(e) {
      const close = e.target.closest('[data-k="close"]');
      if (close) { closePopover(); return; }
      const action = e.target.closest('[data-act]')?.dataset.act;
      if (action) runPopAction(action);
    }

    connect();
    // 首帧还没拿到状态时重发 watch：设置页重渲染/原生端口刚重连时，
    // 单次 postMessage 可能丢失；重发同一个 root 在 host 侧是幂等的。
    watchRetryTimer = setInterval(() => {
      // 刚切换目录时 host 会先推一个 unknown 占位；如果这一轮轮询没被
      // 启动（或消息丢了），current 会停在 unknown，也要继续重发 watch。
      const pendingFirstState = !current || current.state === 'unknown';
      if (pendingFirstState && !hostError) sendWatch(true);
    }, 1200);
    render();

    return () => {
      disposed = true;
      clearTimeout(firstStateTimer);
      clearTimeout(reconnectTimer);
      clearInterval(watchRetryTimer);
      clearTimeout(uiErrorTimer);
      for (const entry of pending.values()) clearTimeout(entry.timer);
      pending.clear();
      closePopover();
      if (port) {
        try { port.disconnect(); } catch {}
        port = null;
      }
    };
  },
};
