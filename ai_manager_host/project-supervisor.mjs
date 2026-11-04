// project-supervisor.mjs — 本地「Java 终极笔记」项目监管
// 职责：探测 4321/4400、启动/停止/重启/构建、读取学习数据、导出备份、读取日志。
// 设计边界：
// - 只操作一个固定项目（路径可用 JAVA_NOTES_ROOT 覆盖），不接受页面传入任意路径/命令；
// - 端口被其他程序占用时拒绝启动，不按端口杀进程；
// - 停止前用进程命令行确认是本项目 node 进程，避免误杀；
// - 学习数据优先读批注服务 HTTP，失败时回退到 server-data 文件快照。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

// 仓库不写死个人目录；默认按当前用户定位同级的 Java 终极笔记项目。
export const DEFAULT_PROJECT_ROOT = path.join(os.homedir(), 'IdeaProjects', 'Java终极笔记');
const SITE_PORT = 4321;
const ANNO_PORT = 4400;
const PROBE_TIMEOUT_MS = 1500;
const PORT_TIMEOUT_MS = 500;
const FAST_POLL_MS = 4000;
const SLOW_POLL_MS = 15000;
const BUSY_POLL_MS = 900;
const START_TIMEOUT_MS = 180_000;
const BUILD_TIMEOUT_MS = 300_000;
const SITE_ONLY_GRACE_MS = 65_000;
const MAX_LOG_CHARS = 16_000;

export class ProjectError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.name = 'ProjectError';
    this.code = code;
    this.detail = detail;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function stripAnsi(input) {
  return String(input || '')
    // CSI / OSC / 常见终端控制序列
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

export function tailText(text, maxChars = MAX_LOG_CHARS) {
  const clean = stripAnsi(text);
  if (clean.length <= maxChars) return clean;
  return clean.slice(-maxChars);
}

export function isSameLocalDay(ts, now = Date.now()) {
  const a = new Date(Number(ts));
  const b = new Date(Number(now));
  return a.getFullYear() === b.getFullYear()
    && a.getMonth() === b.getMonth()
    && a.getDate() === b.getDate();
}

// 把 usage / review-log / annos 三种本地数据归一成 Widget 需要的形状。
// 纯函数，便于单测；HTTP 与文件回退共用。
export function normalizeLearning({ usage, review, annos, now = Date.now() }) {
  const modules = usage && typeof usage === 'object' && usage.modules && typeof usage.modules === 'object'
    ? usage.modules
    : {};
  let totalMs = Number(usage?.totalMs) || 0;
  let totalVisits = Number(usage?.totalVisits) || 0;
  // 文件快照没有 totalMs/totalVisits；HTTP summary 有。字段缺失时按模块累加，
  // 不要因为其中一个字段非零就跳过另一个字段的补算。
  if (!totalMs || !totalVisits) {
    let sumMs = 0;
    let sumVisits = 0;
    for (const m of Object.values(modules)) {
      sumMs += Number(m?.ms) || 0;
      sumVisits += Number(m?.visits) || 0;
    }
    if (!totalMs) totalMs = sumMs;
    if (!totalVisits) totalVisits = sumVisits;
  }

  let lastPath = '';
  let lastAt = 0;
  for (const m of Object.values(modules)) {
    const paths = m && typeof m === 'object' && m.paths && typeof m.paths === 'object' ? m.paths : {};
    for (const [p, info] of Object.entries(paths)) {
      if (!p || !p.startsWith('/')) continue;
      const at = Number(info?.lastAt) || 0;
      if (at > lastAt) { lastAt = at; lastPath = p; }
    }
  }

  const reviewItems = review && typeof review === 'object' && review.items && typeof review.items === 'object'
    ? review.items
    : {};
  let reviewTotal = 0;
  let todayReview = 0;
  for (const item of Object.values(reviewItems)) {
    if (!item || item.ok === false) continue;
    reviewTotal++;
    if (isSameLocalDay(item.at, now)) todayReview++;
  }

  let annotationPages = 0;
  let annotations = 0;
  const pages = annos && typeof annos === 'object' && annos.pages && typeof annos.pages === 'object'
    ? annos.pages
    : {};
  for (const list of Object.values(pages)) {
    if (!Array.isArray(list) || list.length === 0) continue;
    annotationPages++;
    for (const item of list) {
      if (!item || item.status === 'deleted') continue;
      annotations++;
    }
  }

  const updatedAt = Math.max(
    Number(usage?.updatedAt) || 0,
    Number(review?.updatedAt) || 0,
    Number(annos?.updatedAt) || 0,
    0,
  );

  return {
    totalMs,
    totalVisits,
    usageMinutes: Math.round(totalMs / 60_000),
    todayReview,
    reviewTotal,
    annotations,
    annotationPages,
    lastPath,
    lastAt,
    updatedAt,
  };
}

export function classifyState({ busy, phase, site, anno, lastError }) {
  if (busy) return phase === 'stopping' ? 'stopping' : 'starting';
  if (site?.foreign) return 'port_conflict';
  if (site?.ok && anno?.ok) return 'running_full';
  if (site?.ok) return 'running_site_only';
  if (lastError) return 'error';
  return 'stopped';
}

function emptyState() {
  return {
    project: 'java-notes',
    state: 'unknown',
    phase: 'idle',
    message: '',
    busy: false,
    site: {
      port: SITE_PORT,
      ok: false,
      portOpen: false,
      foreign: false,
      pid: null,
      url: `http://127.0.0.1:${SITE_PORT}`,
      startedAt: 0,
    },
    anno: {
      port: ANNO_PORT,
      ok: false,
      portOpen: false,
      pid: null,
      url: `http://127.0.0.1:${ANNO_PORT}`,
      startedAt: 0,
    },
    learning: {
      ok: false,
      live: false,
      source: '',
      totalMs: 0,
      totalVisits: 0,
      usageMinutes: 0,
      todayReview: 0,
      reviewTotal: 0,
      annotations: 0,
      annotationPages: 0,
      lastPath: '',
      lastAt: 0,
      updatedAt: 0,
    },
    lastError: null,
    checkedAt: 0,
  };
}

function readJsonFile(file) {
  try {
    // start.ps1 用 Windows PowerShell 的 utf8 写 pids.json，会带 BOM；
    // 直接 JSON.parse 会失败，导致明明在运行却被判成 offline。
    const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // Windows 上对存在但无权限的进程可能返回 EPERM
    return e && e.code === 'EPERM';
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function execFileAsync(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function portOpen(port) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.setTimeout(PORT_TIMEOUT_MS);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

async function fetchText(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } catch {
    return { ok: false, status: 0, text: '' };
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url, timeoutMs = PROBE_TIMEOUT_MS) {
  const r = await fetchText(url, timeoutMs);
  if (!r.ok) return null;
  try { return JSON.parse(r.text); } catch { return null; }
}

async function listenerPid(port) {
  if (process.platform !== 'win32') return null;
  try {
    const r = await execFileAsync('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `(Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`,
    ], { timeout: 4000, maxBuffer: 16 * 1024 });
    const n = Number(String(r.stdout || '').trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export class JavaNotesProject {
  constructor({ root = process.env.JAVA_NOTES_ROOT || DEFAULT_PROJECT_ROOT, onState = () => {}, now = () => Date.now() } = {}) {
    this.root = path.resolve(root);
    this.siteDir = path.join(this.root, 'site');
    this.runDir = path.join(this.root, '.run');
    this.onState = onState;
    this.now = now;

    this.state = emptyState();
    this.busy = false;
    this.phase = 'idle';
    this.lastError = null;
    this.watched = false;
    this.disposed = false;
    this.polling = false;
    this.timer = null;
    this.pollDelay = SLOW_POLL_MS;
    this.lastEmit = '';
    this.startChild = null;
    this.annoChild = null;
    this.startAt = 0;
    this.buildAt = 0;
    this.withAnno = true;
    this.siteStartedAt = 0;
    this.annoStartedAt = 0;
    this.lastLearningSignature = '';
    this._tick = this._tick.bind(this);
  }

  getSnapshot() {
    return JSON.parse(JSON.stringify(this.state));
  }

  setWatched(watch) {
    this.watched = !!watch;
    this.pollDelay = this.watched ? FAST_POLL_MS : SLOW_POLL_MS;
    if (this.watched) this._schedule(0);
  }

  start() {
    this._schedule(0);
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = null;
    if (this.annoChild && !this.annoChild.killed) {
      try { this.annoChild.unref(); } catch {}
    }
  }

  _schedule(delay) {
    if (this.disposed) return;
    clearTimeout(this.timer);
    const wait = delay ?? (this.busy ? BUSY_POLL_MS : this.pollDelay);
    this.timer = setTimeout(this._tick, wait);
    this.timer.unref?.();
  }

  async _tick() {
    if (this.disposed) return;
    try { await this.refresh(); } catch (e) { this._failFromError(e); }
    if (this.disposed) return;
    this._emit();
    this._schedule();
  }

  _emit(force = false) {
    // checkedAt / snapshotAt 是展示用的每秒变化值，不能让它们触发重复推送；
    // 只在服务状态或学习数据真正变化时发 project:state。
    const sig = JSON.stringify({
      ...this.state,
      checkedAt: 0,
      learning: { ...this.state.learning, checkedAt: 0, snapshotAt: 0 },
    });
    if (!force && sig === this.lastEmit) return;
    this.lastEmit = sig;
    try { this.onState(this.getSnapshot()); } catch {}
  }

  _setBusy(phase, message, timeoutMs) {
    this.busy = true;
    this.phase = phase;
    this.startAt = this.now();
    this.buildAt = this.buildAt || 0;
    this.startDeadline = this.now() + timeoutMs;
    this.state.busy = true;
    this.state.phase = phase;
    this.state.message = message;
    this.state.state = phase === 'stopping' ? 'stopping' : 'starting';
    this.state.lastError = null;
    this._emit(true);
  }

  _clearBusy(message = '') {
    this.busy = false;
    this.phase = 'idle';
    this.startDeadline = 0;
    this.state.busy = false;
    this.state.phase = 'idle';
    this.state.message = message;
    this.state.lastError = this.lastError;
  }

  _fail(code, message, detail = '') {
    this.lastError = { code, message, detail: String(detail || '').slice(0, 4000) };
    this.state.lastError = this.lastError;
    this.state.state = this.state.site?.ok ? 'running_site_only' : 'error';
    this._clearBusy(message);
    this.state.lastError = this.lastError;
    this._emit(true);
  }

  _failFromError(e) {
    const code = e?.code || 'project_error';
    this._fail(code, e?.message || String(e), e?.detail || '');
  }

  async refresh() {
    if (this.polling) return this.state;
    this.polling = true;
    try {
      const pids = readJsonFile(path.join(this.runDir, 'pids.json')) || {};
      const pidsMtime = this._fileMtime(path.join(this.runDir, 'pids.json'));
      const sitePid = pids.site && pidAlive(Number(pids.site)) ? Number(pids.site) : null;
      const annoPid = (pids.editor && pidAlive(Number(pids.editor)))
        ? Number(pids.editor)
        : (this.annoChild?.pid && pidAlive(this.annoChild.pid) ? this.annoChild.pid : null);

      const [sitePortOpen, annoPortOpen] = await Promise.all([portOpen(SITE_PORT), portOpen(ANNO_PORT)]);
      let siteHttp = { ok: false, status: 0, text: '' };
      if (sitePortOpen) siteHttp = await fetchText(`http://127.0.0.1:${SITE_PORT}/`);
      let annoHealth = null;
      if (annoPortOpen) annoHealth = await fetchJson(`http://127.0.0.1:${ANNO_PORT}/api/health`);

      const siteOk = !!siteHttp.ok;
      // 不仅看 ok，还要有批注服务的统计字段，避免 4400 上别的服务碰巧返回 ok。
      const annoOk = !!annoHealth?.ok
        && (Number.isFinite(Number(annoHealth.pages)) || Number.isFinite(Number(annoHealth.usageModules)));
      // 本地项目标题/路由标记；pids 能确认归属时无需依赖 HTML 文案。
      const ownByHtml = /Java|面试笔记|hot200|project\/source/i.test(siteHttp.text || '');
      let siteOwn = siteOk && ownByHtml;
      // 页面文案没有标记时，只有「pids 里的 site PID == 4321 实际监听 PID」
      // 才算本项目，避免 pids 过期时把别的服务误认成自己的站点。
      if (siteOk && !siteOwn && sitePid) {
        const owner = await listenerPid(SITE_PORT);
        siteOwn = owner === sitePid;
      }
      // 只有 HTTP 已响应且内容不是本项目时才判「外部占用」。
      // 端口刚监听但 HTTP 还没起来时算 unknown，不能误报 port_conflict。
      const siteForeign = siteOk && !siteOwn;

      if (siteOk) {
        if (!this.siteStartedAt) this.siteStartedAt = pidsMtime || this.now();
      } else {
        this.siteStartedAt = 0;
      }
      if (annoOk) {
        if (!this.annoStartedAt) this.annoStartedAt = pidsMtime || this.now();
      } else {
        this.annoStartedAt = 0;
      }

      // 启动/构建超时：不要无限转圈
      if (this.busy && this.startDeadline && this.now() > this.startDeadline) {
        const code = this.phase === 'building' ? 'build_timeout' : 'start_timeout';
        this._fail(code, this.phase === 'building' ? '构建/预览超时，请查看日志' : '启动超时，请查看日志');
      }

      // 站点已就绪但批注超过宽限期未起：结束等待，保留「部分运行」状态，
      // 让用户先打开站点；start.ps1 后续如果起成功了，下次轮询会自然变 full。
      if (this.busy && this.withAnno && this.phase === 'starting_site' && siteOk && !annoOk
        && this.now() - this.startAt > SITE_ONLY_GRACE_MS) {
        this._clearBusy('批注服务启动较慢，站点已可阅读');
        this.state.phase = 'idle';
        this.state.lastError = null;
      }

      if (this.busy && siteOk && (!this.withAnno || annoOk)) {
        this._clearBusy('');
        this.lastError = null;
        this.state.lastError = null;
      }

      const learning = await this._readLearning({ annoOk, pidsMtime });
      const site = {
        port: SITE_PORT,
        ok: siteOk,
        portOpen: sitePortOpen,
        foreign: siteForeign,
        pid: sitePid,
        url: `http://127.0.0.1:${SITE_PORT}`,
        startedAt: this.siteStartedAt || 0,
      };
      const anno = {
        port: ANNO_PORT,
        ok: annoOk,
        portOpen: annoPortOpen,
        pid: annoPid,
        url: `http://127.0.0.1:${ANNO_PORT}`,
        startedAt: this.annoStartedAt || 0,
      };
      const state = classifyState({ busy: this.busy, phase: this.phase, site, anno, lastError: this.lastError });
      this.state = {
        ...this.state,
        state,
        busy: this.busy,
        phase: this.phase,
        message: this.state.message || '',
        site,
        anno,
        learning,
        lastError: this.lastError,
        checkedAt: this.now(),
      };
    } finally {
      this.polling = false;
    }
    return this.state;
  }

  async _readLearning({ annoOk, pidsMtime }) {
    let data = null;
    let source = '';
    let live = false;
    if (annoOk) {
      const [usage, review, annos] = await Promise.all([
        fetchJson(`http://127.0.0.1:${ANNO_PORT}/api/usage/summary`),
        fetchJson(`http://127.0.0.1:${ANNO_PORT}/api/review/log`),
        fetchJson(`http://127.0.0.1:${ANNO_PORT}/api/anno/all`),
      ]);
      if (usage || review || annos) {
        data = normalizeLearning({ usage, review, annos, now: this.now() });
        source = 'http';
        live = true;
      }
    }
    if (!data) {
      const usage = readJsonFile(path.join(this.siteDir, 'server-data', 'usage.json'));
      const review = readJsonFile(path.join(this.siteDir, 'server-data', 'review-log.json'));
      const annos = readJsonFile(path.join(this.siteDir, 'server-data', 'annos.json'));
      if (usage || review || annos) {
        data = normalizeLearning({ usage, review, annos, now: this.now() });
        source = 'file';
      }
    }
    if (!data) {
      return {
        ...this.state.learning,
        ok: false,
        live: false,
        source: '',
        checkedAt: this.now(),
      };
    }
    return {
      ...data,
      ok: true,
      live,
      source,
      checkedAt: this.now(),
      // 文件回退的时间戳 / pids 时间只用于界面提示，不参与状态签名以外的判断
      snapshotAt: source === 'file' ? (pidsMtime || this.now()) : this.now(),
    };
  }

  _fileMtime(file) {
    try { return fs.statSync(file).mtimeMs; } catch { return 0; }
  }

  async _commandStart({ withAnno = true } = {}) {
    if (this.busy) {
      return { ok: true, message: this.state.message || '已在启动中', state: this.getSnapshot() };
    }
    if (!fs.existsSync(this.root)) {
      throw new ProjectError('project_missing', `项目目录不存在：${this.root}`);
    }
    if (!fs.existsSync(this.siteDir)) {
      throw new ProjectError('project_missing', '项目缺少 site/ 目录');
    }

    await this.refresh();
    const site = this.state.site;
    const anno = this.state.anno;
    const sitePortOpen = await portOpen(SITE_PORT);
    const annoPortOpen = await portOpen(ANNO_PORT);

    if (sitePortOpen && !site.ok) {
      throw new ProjectError('port_not_responding', `端口 ${SITE_PORT} 有进程但没有响应，请先检查占用`);
    }
    if (site.ok && !site.foreign && anno.ok) {
      return { ok: true, message: '站点与批注服务已在运行', state: this.getSnapshot() };
    }
    if (annoPortOpen && !anno.ok) {
      throw new ProjectError('anno_port_conflict', `端口 ${ANNO_PORT} 被其他服务占用，未自动清理`);
    }

    this.withAnno = !!withAnno;
    if (site.ok && !site.foreign) {
      if (!withAnno) {
        return { ok: true, message: '站点已在运行', state: this.getSnapshot() };
      }
      this._setBusy('starting_anno', '正在补启批注服务…', START_TIMEOUT_MS);
      try {
        await this._spawnAnno();
      } catch (e) {
        this._fail(e?.code || 'anno_start_failed', e?.message || String(e), e?.detail || '');
        throw e;
      }
      return { ok: true, message: '正在补启批注服务…', state: this.getSnapshot() };
    }

    if (site.foreign) {
      throw new ProjectError('site_port_conflict', `端口 ${SITE_PORT} 被其他程序占用，未自动清理`);
    }

    this._setBusy('starting_site', withAnno ? '正在启动站点与批注服务…' : '正在启动站点…', START_TIMEOUT_MS);
    try {
      await this._spawnStart({ build: false, withAnno });
    } catch (e) {
      this._fail(e?.code || 'start_failed', e?.message || String(e), e?.detail || '');
      throw e;
    }
    return { ok: true, message: '正在启动站点…', state: this.getSnapshot() };
  }

  async _commandStop() {
    if (this.busy && this.phase === 'stopping') {
      return { ok: true, message: '正在停止…', state: this.getSnapshot() };
    }
    this._setBusy('stopping', '正在停止本地服务…', 30_000);
    const killed = await this._stopProcesses();
    await this.refresh();
    this._clearBusy('');
    this.lastError = null;
    this.state.lastError = null;
    this.state.state = this.state.site?.ok ? 'running_site_only' : 'stopped';
    this._emit(true);
    if (this.state.site?.ok || this.state.anno?.ok) {
      throw new ProjectError('stop_incomplete', '仍有项目服务在运行，可能由其他终端启动或被占用', JSON.stringify(killed));
    }
    return { ok: true, message: '已停止', state: this.getSnapshot() };
  }

  async _commandRestart({ withAnno = true } = {}) {
    if (this.busy) throw new ProjectError('busy', '当前有启动/停止/构建任务进行中');
    this._setBusy('stopping', '正在重启：先停止…', 30_000);
    await this._stopProcesses();
    this.busy = false;
    this.phase = 'idle';
    return this._commandStart({ withAnno });
  }

  async _commandBuild() {
    if (this.busy) throw new ProjectError('busy', '当前有启动/停止/构建任务进行中');
    this._setBusy('stopping', '正在停止服务，准备构建…', 30_000);
    await this._stopProcesses();
    this.busy = false;
    this.phase = 'idle';
    this.withAnno = true;
    this.buildAt = this.now();
    this._setBusy('building', '正在构建并启动预览（约 30–60 秒）…', BUILD_TIMEOUT_MS);
    try {
      await this._spawnStart({ build: true, withAnno: true });
    } catch (e) {
      this._fail(e?.code || 'build_failed', e?.message || String(e), e?.detail || '');
      throw e;
    }
    return { ok: true, message: '正在构建并启动预览…', state: this.getSnapshot() };
  }

  async _commandBackup() {
    const script = path.join(this.siteDir, 'scripts', 'backup.mjs');
    if (!fs.existsSync(script)) throw new ProjectError('backup_missing', '找不到备份脚本 scripts/backup.mjs');
    if (!fs.existsSync(this.siteDir)) throw new ProjectError('project_missing', '项目缺少 site/ 目录');
    let stdout = '';
    try {
      const r = await execFileAsync(process.execPath, [script, 'export'], {
        cwd: this.siteDir,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        env: { ...process.env },
      });
      stdout = r.stdout || '';
    } catch (e) {
      throw new ProjectError('backup_failed', '导出备份失败', String(e.stderr || e.stdout || e.message || e));
    }
    let newest = null;
    let newestMtime = 0;
    const backupDir = path.join(this.siteDir, 'backups');
    try {
      for (const name of fs.readdirSync(backupDir)) {
        if (!name.endsWith('.json')) continue;
        const full = path.join(backupDir, name);
        const st = fs.statSync(full);
        if (st.mtimeMs > newestMtime) { newestMtime = st.mtimeMs; newest = full; }
      }
    } catch {}
    return {
      ok: true,
      message: newest ? `备份已导出：${path.basename(newest)}` : '备份已导出',
      path: newest || '',
      size: newest ? fs.statSync(newest).size : 0,
      output: stdout.trim(),
    };
  }

  async _commandLogs({ tail = 80 } = {}) {
    const n = Math.max(20, Math.min(200, Number(tail) || 80));
    const files = [
      ['site.log', '站点'],
      ['site.err.log', '站点错误'],
      ['anno.log', '批注服务'],
      ['anno.err.log', '批注错误'],
    ];
    const chunks = [];
    for (const [name, label] of files) {
      const full = path.join(this.runDir, name);
      let text = '';
      try {
        const raw = fs.readFileSync(full, 'utf8');
        text = stripAnsi(raw).split(/\r?\n/).filter(Boolean).slice(-n).join('\n');
      } catch {}
      if (text) chunks.push(`[${label} · ${name}]\n${text}`);
    }
    return {
      ok: true,
      text: chunks.length ? tailText(chunks.join('\n\n')) : '暂无日志（服务可能尚未启动）',
    };
  }

  async handleCommand(command, payload = {}) {
    switch (command) {
      case 'start':
        return this._commandStart({ withAnno: payload.withAnno !== false });
      case 'stop':
        return this._commandStop();
      case 'restart':
        return this._commandRestart({ withAnno: payload.withAnno !== false });
      case 'build':
        return this._commandBuild();
      case 'backup':
        return this._commandBackup();
      case 'logs':
        return this._commandLogs(payload);
      case 'refresh':
        await this.refresh();
        return { ok: true, state: this.getSnapshot() };
      default:
        throw new ProjectError('unknown_command', `未知项目命令：${command}`);
    }
  }

  async _spawnStart({ build, withAnno }) {
    if (process.platform !== 'win32') {
      throw new ProjectError('unsupported_platform', '一键启动目前仅支持 Windows');
    }
    const script = path.join(this.root, 'start.ps1');
    if (!fs.existsSync(script)) throw new ProjectError('start_script_missing', `找不到启动脚本：${script}`);
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script];
    if (build) args.push('-Build');
    if (!withAnno) args.push('-NoEditor');
    // 注意：Windows + Node 的 detached:true 会创建一个没有控制台的进程，
    // 在当前环境里 PowerShell 会直接 exit 0 而不执行脚本。保持普通子进程 +
    // stdio:'ignore'，再 unref，让宿主退出时事件循环不被它拖住；项目进程由
    // start.ps1 内部的 Start-Process 启动，本身不依赖宿主的生命周期。
    const child = spawn('powershell.exe', args, {
      cwd: this.root,
      env: { ...process.env, NO_OPEN: '1' },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    this.startChild = child;
    child.once('error', (e) => {
      if (this.busy && (this.phase === 'starting_site' || this.phase === 'building')) {
        this._fail('spawn_failed', `无法启动 PowerShell：${e?.message || e}`);
      }
    });
    child.once('exit', (code) => {
      if (code && code !== 0 && this.busy
        && (this.phase === 'starting_site' || this.phase === 'building')) {
        this._fail('start_failed', `启动脚本退出（code ${code}），请查看日志`);
      }
    });
  }

  async _spawnAnno() {
    if (process.platform !== 'win32') {
      throw new ProjectError('unsupported_platform', '批注服务启动目前仅支持 Windows');
    }
    const script = path.join(this.siteDir, 'scripts', 'anno-server.mjs');
    if (!fs.existsSync(script)) throw new ProjectError('anno_script_missing', '找不到批注服务脚本');
    const child = spawn(process.execPath, [script], {
      cwd: this.siteDir,
      env: { ...process.env, ANNO_PORT: String(ANNO_PORT) },
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    this.annoChild = child;
    this.annoStartedAt = this.now();
    child.once('error', (e) => {
      if (this.busy && this.phase === 'starting_anno') {
        this._fail('anno_spawn_failed', `无法启动批注服务：${e?.message || e}`);
      }
    });
    child.once('exit', (code) => {
      if (code && code !== 0 && this.busy && this.phase === 'starting_anno') {
        this._fail('anno_start_failed', `批注服务启动失败（code ${code}），请查看日志`);
      }
    });
  }

  async _findProjectPids() {
    if (process.platform !== 'win32') return [];
    const script = [
      "$ErrorActionPreference='SilentlyContinue'",
      "$root=" + psQuote(this.root),
      "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" |",
      "  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($root) -and",
      "    ($_.CommandLine -like '*astro.js*' -or $_.CommandLine -like '*anno-server.mjs*') } |",
      "  Select-Object -ExpandProperty ProcessId",
    ].join('\n');
    try {
      const r = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        timeout: 10_000,
        maxBuffer: 128 * 1024,
      });
      return String(r.stdout || '')
        .split(/\s+/)
        .map((x) => Number(x))
        .filter((x) => Number.isInteger(x) && x > 0);
    } catch {
      return [];
    }
  }

  async _processCommandLine(pid) {
    if (!pid || process.platform !== 'win32') return '';
    const script = [
      "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "$OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
      "$ErrorActionPreference='SilentlyContinue'",
      "$p=Get-CimInstance Win32_Process -Filter \"ProcessId=" + Number(pid) + "\"",
      "if ($p.CommandLine) { $p.CommandLine }",
    ].join('\n');
    try {
      const r = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        timeout: 5_000,
        maxBuffer: 64 * 1024,
      });
      return String(r.stdout || '');
    } catch {
      return '';
    }
  }

  async _verifyOwned(pid) {
    if (!pid || process.platform !== 'win32') return false;
    // 宿主自己补启的批注进程：命令行可能是相对路径 scripts/anno-server.mjs，
    // 不含项目根目录，但 PID 是我们亲手 spawn 的，直接认可。
    if (this.annoChild?.pid === pid && this.annoChild.exitCode == null && pidAlive(pid)) return true;
    const line = await this._processCommandLine(pid);
    if (line.includes(this.root) && (/astro\.js/i.test(line) || /anno-server\.mjs/i.test(line))) {
      return true;
    }
    // start.ps1 启动的批注进程命令行也可能是相对路径；用 pids.json 的 PID
    // 与实际 4321/4400 监听 PID 交叉验证，避免把别的 node 服务当成自己的。
    const stored = readJsonFile(path.join(this.runDir, 'pids.json')) || {};
    if (Number(stored.editor) === pid || Number(stored.site) === pid) {
      const port = Number(stored.site) === pid ? SITE_PORT : ANNO_PORT;
      return (await listenerPid(port)) === pid;
    }
    return false;
  }

  async _verifyStartScript(pid) {
    if (!pid || process.platform !== 'win32') return false;
    const line = await this._processCommandLine(pid);
    return line.includes(this.root) && /start\.ps1/i.test(line);
  }

  async _stopProcesses() {
    const pids = new Set();
    const pidFile = path.join(this.runDir, 'pids.json');
    const stored = readJsonFile(pidFile) || {};
    for (const p of [stored.site, stored.editor]) {
      if (pidAlive(Number(p))) pids.add(Number(p));
    }
    for (const p of await this._findProjectPids()) pids.add(p);
    if (this.startChild?.pid && pidAlive(this.startChild.pid)
      && await this._verifyStartScript(this.startChild.pid)) {
      try { process.kill(this.startChild.pid); } catch {}
      // 启动脚本可能刚 spawn 出 node，杀掉脚本后再扫一次，避免漏掉新子进程。
      await sleep(250);
      for (const p of await this._findProjectPids()) pids.add(p);
    }
    if (this.annoChild?.pid && pidAlive(this.annoChild.pid)) {
      pids.add(this.annoChild.pid);
    }

    const killed = [];
    const skipped = [];
    for (const pid of pids) {
      if (!(await this._verifyOwned(pid))) { skipped.push(pid); continue; }
      try {
        process.kill(pid, 'SIGTERM');
        killed.push(pid);
      } catch {
        try { process.kill(pid, 'SIGKILL'); killed.push(pid); } catch {}
      }
    }
    // 给 Node 一点时间退出；仍活着再强制结束
    await sleep(900);
    for (const pid of killed) {
      if (!pidAlive(pid)) continue;
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    // 等端口释放，避免 restart/build 紧接着启动时撞上 TIME_WAIT 或旧进程。
    const closeDeadline = this.now() + 5000;
    while (this.now() < closeDeadline) {
      const [siteOpen, annoOpen] = await Promise.all([portOpen(SITE_PORT), portOpen(ANNO_PORT)]);
      if (!siteOpen && !annoOpen) break;
      await sleep(250);
    }
    // 只有所有候选进程都确认不在了才清理 pid 文件；有 skipped（归属无法确认）
    // 时保留现场，避免下次启动/停止丢掉线索。
    if (pids.size && [...pids].every((pid) => !pidAlive(pid))) {
      try { fs.rmSync(pidFile, { force: true }); } catch {}
    }
    this.startChild = null;
    this.annoChild = null;
    this.siteStartedAt = 0;
    this.annoStartedAt = 0;
    this.lastLearningSignature = '';
    return { killed, skipped };
  }
}
