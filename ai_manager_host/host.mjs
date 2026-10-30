#!/usr/bin/env node
// host.mjs — 本地 AI 应用管理器 · Chrome Native Messaging host
// 与扩展经 stdio 交换 JSON 帧（4 字节小端长度前缀），Chrome 生命周期管理进程。
// 能力：
//   1. 进程/HTTP 探测本地 AI 应用运行状态（Ollama、LM Studio、Claude 等）
//   2. Claude Code 会话日志（~/.claude/projects/*.jsonl）实时消息 + 任务完成事件
//   3. Codex（ChatGPT 桌面版）会话日志（~/.codex/sessions/*.jsonl）实时消息 + 任务完成事件
//   4. UIA 枚举白名单进程的模态弹窗（#32770），扩展遥控「确认/否认」
// 协议（host → 扩展）：
//   {type:'apps', apps:[{id,name,status,detail}]}
//   {type:'message', app, role, text, ts, done}
//   {type:'dialog', id, app, title, buttons:[{id,label}]}
//   {type:'dialog:closed', id}
//   {type:'sys', metrics:{cpu,mem,swap,disk,gpu,cpuTemp,gpuTemp,...}}  ← 系统资源轮询
//   {type:'session', sessions:[{app,id,project,model,sumIn,sumCacheRead,sumOut,turns,lastTs}]} ← 多会话统计（claude-code + codex）
//   {type:'snapshot', apps, dialogs, messages, stats}   ← 响应 {type:'query'}
// 协议（扩展 → host）：
//   {type:'query'} / {type:'dialog:respond', dialogId, buttonId}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractModelInfo, formatAppDetail } from './probe.mjs';
import { fileURLToPath } from 'node:url';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

// 轮询节奏。host 是常驻进程，所有间隔都按“够用即可”设置：
// - 进程扫描 / 日志 / 弹窗都是低频事件，不必 1s 级；
// - 会话统计按文件 mtime 缓存，但仍限制整文件重扫频率；
// - sysmon 单次 PowerShell 约 1.6s，页面可见时 5s 一轮，后台 15s。
const PROCESS_SCAN_INTERVAL_MS = 8000;
const LOG_POLL_INTERVAL_MS = 1500;
const DIALOG_SCAN_INTERVAL_MS = 10000;
const SESSION_STATS_MIN_MS = 5000;
const SYSMON_FAST_MS = 5000;
const SYSMON_SLOW_MS = 15000;

// ---------- Native Messaging 帧协议 ----------
let inBuf = Buffer.alloc(0);
process.stdin.on('data', (chunk) => {
  inBuf = Buffer.concat([inBuf, chunk]);
  while (inBuf.length >= 4) {
    const len = inBuf.readUInt32LE(0);
    if (inBuf.length < 4 + len) break;
    const body = inBuf.slice(4, 4 + len).toString('utf8');
    inBuf = inBuf.slice(4 + len);
    try { handleRequest(JSON.parse(body)); }
    catch (e) { post({ type: 'error', message: String(e && e.message || e) }); }
  }
});
process.stdin.on('end', () => process.exit(0));

function post(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

// ---------- 应用注册表 ----------
// kind: 'http'（API 探测）/ 'log'（日志 adapter）/ 'proc'（纯进程检测）
const APPS = [
  { id: 'claude-code', name: 'Claude Code', kind: 'log', detail: '会话日志 ~/.claude/projects' },
  // ChatGPT 桌面版 = OpenAI Codex：日志在 ~/.codex/sessions，进程名 ChatGPT.exe / Codex.exe
  // （进程只作在线检测；会话 jsonl 在应用退出后仍留存，日志 adapter 自身可判定状态）
  { id: 'codex', name: 'ChatGPT 桌面版', kind: 'log', procs: ['ChatGPT.exe', 'Codex.exe'], detail: '会话日志 ~/.codex/sessions' },
  { id: 'ollama', name: 'Ollama', kind: 'http', procs: ['ollama.exe'], probe: { url: 'http://127.0.0.1:11434/api/tags' }, detail: '本地 API :11434' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'http', procs: ['lms.exe'], probe: { url: 'http://127.0.0.1:1234/v1/models' }, detail: '本地 API :1234' },
  // 8080 常被多个服务共用：只在对应进程存在时探测，避免把别的服务误判成自己
  { id: 'llamacpp', name: 'llama.cpp', kind: 'http', procs: ['llama-server.exe', 'llama-server'], probe: { url: 'http://127.0.0.1:8080/v1/models' }, probeWithProcOnly: true, detail: '本地 API :8080' },
  { id: 'vllm', name: 'vLLM', kind: 'http', procs: ['vllm.exe'], cmdPatterns: [/\bvllm\b/i], probe: { url: 'http://127.0.0.1:8000/v1/models' }, detail: '本地 API :8000' },
  { id: 'localai', name: 'LocalAI', kind: 'http', procs: ['local-ai.exe', 'localai.exe'], probe: { url: 'http://127.0.0.1:8080/v1/models' }, probeWithProcOnly: true, detail: '本地 API :8080' },
  { id: 'koboldcpp', name: 'KoboldCpp', kind: 'http', procs: ['koboldcpp.exe'], probe: { url: 'http://127.0.0.1:5001/api/v1/model' }, detail: '本地 API :5001' },
  { id: 'gpt4all', name: 'GPT4All', kind: 'http', procs: ['gpt4all.exe'], probe: { url: 'http://127.0.0.1:4891/v1/models' }, detail: '本地 API :4891' },
  { id: 'jan', name: 'Jan', kind: 'http', procs: ['jan.exe'], probe: { url: 'http://127.0.0.1:1337/v1/models' }, detail: '本地 API :1337' },
  { id: 'anythingllm', name: 'AnythingLLM', kind: 'http', procs: ['anythingllm.exe'], probe: { url: 'http://127.0.0.1:3001/api/ping' }, detail: '本地服务 :3001' },
  { id: 'textgen', name: 'text-generation-webui', kind: 'http', cmdPatterns: [/text-generation-webui/i, /webui\.py/i], probe: { url: 'http://127.0.0.1:5000/v1/models' }, probeWithProcOnly: true, detail: '本地 API :5000' },
  { id: 'cherry-studio', name: 'Cherry Studio', kind: 'proc', procs: ['cherry studio.exe', 'cherry-studio.exe'], detail: '桌面 AI 客户端' },
  { id: 'chatbox', name: 'Chatbox', kind: 'proc', procs: ['chatbox.exe'], detail: '桌面 AI 客户端' },
  { id: 'claude-desktop', name: 'Claude 桌面版', kind: 'proc', procs: ['claude.exe'] },
  { id: 'cursor', name: 'Cursor', kind: 'proc', procs: ['cursor.exe'], detail: 'AI IDE' },
];

const appStatus = new Map();   // id → 'online' | 'tasking' | 'offline'
const appInfo = new Map();     // id → { models: string[], total: number }（HTTP 探测到的模型信息）
const recent = [];             // 最近消息（快照回放用，上限 50——页面只用于会话状态机，不再渲染历史）
const openDialogs = new Map(); // hwnd → dialog 对象

// snapshot 字节预算：Chrome 对 host→扩展 单条消息限 1MB，超限会杀死连接。
// 按 JSON 序列化字节累计（≤ 512KB），从最新往回装，装不下即止。
function buildSnapshot() {
  const appsPart = currentAppsList();
  const dialogsPart = [...openDialogs.values()];
  const budget = 512 * 1024
    - Buffer.byteLength(JSON.stringify({ apps: appsPart, dialogs: dialogsPart }), 'utf8');
  const picked = [];
  let used = 0;
  for (let i = recent.length - 1; i >= 0 && used < budget; i--) {
    const sz = Buffer.byteLength(JSON.stringify(recent[i]), 'utf8');
    if (used + sz > budget) break;
    used += sz;
    picked.unshift(recent[i]);
  }
  return { type: 'snapshot', apps: appsPart, dialogs: dialogsPart, messages: picked, sessions: sessionsList() };
}

function handleRequest(msg) {
  switch (msg && msg.type) {
    case 'query':
      post(buildSnapshot());
      if (lastSys) post({ type: 'sys', metrics: lastSys }); // 快照附带当前资源数据
      break;
    case 'sysmon': // 页面开关：有面板订阅时 5s 高频，全部断开后 15s 低频
      setSysmonFast(!!msg.fast);
      break;
    case 'dialog:respond':
      clickDialog(msg.dialogId, msg.buttonId);
      break;
    default:
      post({ type: 'error', message: `未知请求：${msg && msg.type}` });
  }
}

// ---------- 会话统计（多会话区分：项目/模型/token/轮次/最近请求） ----------
// 两个日志源共用一套聚合框架，各自的 jsonl 解析器产出统一 stats 形状（外加 app 字段区分）：
//   claude-code（~/.claude/projects/<proj>/<id>.jsonl）：
//     assistant 行带 message.usage（每轮都是全量累计快照，取最后见到的值）
//     与 message.model；project 取行内 cwd 的目录名。
//   codex（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）：
//     session_meta 带 session_id/cwd；turn_context 带 model；
//     token_count.event_msg 带 info.total_token_usage 累计快照；
//     turns 数 user_message 事件个数。
// 跟踪最近 24h 有活动的会话（按 mtime 取前 8 个）：mtime 未变的复用缓存统计，
// 只对增长过的文件重扫（stat 很轻，内容扫描只在变化时发生）。
const SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;
const SESSION_MAX = 8;
let sessionCache = new Map();   // file → {mtimeMs, stats}
let lastSessionsJson = '';      // 上次推送的序列化（无变化不推）

// 递归收集一个目录树下 24h 内有活动的 .jsonl 候选（浅层目录，手动展开两层）
function collectJsonlCandidates(root, cutoff, depth = 2) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (depth > 0) out.push(...collectJsonlCandidates(full, cutoff, depth - 1));
    } else if (ent.name.endsWith('.jsonl')) {
      let st;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.size > 0 && st.mtimeMs >= cutoff) out.push({ full, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

// Claude：projects/<proj>/<id>.jsonl（depth=1 即可覆盖）
function listClaudeSessions(cutoff) {
  return collectJsonlCandidates(CLAUDE_DIR, cutoff, 1);
}
// Codex：sessions/YYYY/MM/DD/rollout-*.jsonl（depth=3）
function listCodexSessions(cutoff) {
  return collectJsonlCandidates(CODEX_DIR, cutoff, 3).filter(c => path.basename(c.full).startsWith('rollout-'));
}

function listActiveSessions() {
  const cutoff = Date.now() - SESSION_WINDOW_MS;
  const cands = [...listClaudeSessions(cutoff), ...listCodexSessions(cutoff)];
  cands.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return cands.slice(0, SESSION_MAX);
}

// 解析一个 jsonl，按行结构分发到对应源的解析器
function scanSessionFile(full) {
  let text;
  try { text = fs.readFileSync(full, 'utf8'); } catch { return null; }
  return full.startsWith(CODEX_DIR) ? scanCodexSession(text) : scanClaudeSession(text);
}

// ---------- Claude Code 会话统计解析 ----------
// usage 为「当前累计快照」：同轮多行会重复，直接取最后见到的值（跨轮求和会翻倍）
function scanClaudeSession(text) {
  let st = null;
  let project = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    if (!project && o.cwd) project = path.basename(String(o.cwd));
    if (o.type === 'assistant' && o.message && o.message.usage) {
      const u = o.message.usage;
      if (!st) {
        st = {
          app: 'claude-code',
          id: o.sessionId || '',
          project: '',
          model: o.message.model || '',
          sumIn: 0, sumCacheRead: 0, sumOut: 0,
          turns: 0, turnIn: 0, turnOut: 0, lastTs: o.timestamp || '',
        };
      }
      st.model = o.message.model || st.model; // 模型可能中途切换，取最新
      st.sumIn = u.input_tokens || 0;
      st.sumCacheRead = u.cache_read_input_tokens || 0;
      st.sumOut = u.output_tokens || 0;
      st.turns += 1;
      st.turnIn = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0);
      st.turnOut = u.output_tokens || 0;
      st.lastTs = o.timestamp || st.lastTs;
    }
  }
  if (st) {
    if (!st.id) st.id = '';
    st.project = project;
  }
  return st;
}

// ---------- Codex（ChatGPT 桌面版）会话统计解析 ----------
// 行结构 {timestamp, type, payload}：
//   session_meta → session_id / cwd；turn_context → model；
//   event_msg{type:'user_message'} → 轮次 +1；
//   event_msg{type:'token_count'} → info.total_token_usage 全量累计快照（取最后值）
function scanCodexSession(text) {
  let st = null;
  let project = '';
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try { o = JSON.parse(line); } catch { continue; }
    const ts = o.timestamp || '';
    if (ts && (!st || ts > st.lastTs)) {
      if (st) st.lastTs = ts;
    }
    if (o.type === 'session_meta' && o.payload) {
      project = path.basename(String(o.payload.cwd || ''));
      if (!st) {
        st = {
          app: 'codex',
          id: o.payload.session_id || '',
          project: '',
          model: '',
          sumIn: 0, sumCacheRead: 0, sumOut: 0,
          turns: 0, turnIn: 0, turnOut: 0, lastTs: ts,
        };
      } else {
        st.id = st.id || o.payload.session_id;
      }
    }
    if (o.type === 'turn_context' && o.payload && o.payload.model) {
      if (!st) {
        st = {
          app: 'codex', id: '', project: '', model: o.payload.model,
          sumIn: 0, sumCacheRead: 0, sumOut: 0,
          turns: 0, turnIn: 0, turnOut: 0, lastTs: ts,
        };
      } else {
        st.model = o.payload.model; // 模型可能中途切换，取最新
      }
    }
    if (o.type === 'event_msg' && o.payload && o.payload.type === 'user_message' && st) {
      st.turns += 1;
    }
    if (o.type === 'event_msg' && o.payload && o.payload.type === 'token_count' && st) {
      const u = o.payload.info && o.payload.info.total_token_usage;
      if (u) {
        // total_token_usage 是会话级累计快照：直接覆盖（同轮重复推送取最后值）
        st.sumIn = u.input_tokens || 0;
        st.sumCacheRead = u.cached_input_tokens || 0;
        st.sumOut = (u.output_tokens || 0) + (u.reasoning_output_tokens || 0);
        st.turnIn = st.sumIn + st.sumCacheRead;
        st.turnOut = st.sumOut;
      }
    }
  }
  if (st) {
    if (!st.id) st.id = '';
    st.project = st.project || project;
  }
  return st;
}

// 缓存中的统计按最近请求时间排序（最新在前）
function sessionsList() {
  return [...sessionCache.values()]
    .map(e => e.stats)
    .sort((a, b) => String(b.lastTs).localeCompare(String(a.lastTs)));
}

let sessionStatsTimer = null;
let lastSessionStatsAt = 0;

// 日志每次推进都刷新统计会反复整文件读取活跃 jsonl；改为 5s 节流。
function scheduleSessionStats() {
  if (sessionStatsTimer) return;
  const wait = Math.max(0, SESSION_STATS_MIN_MS - (Date.now() - lastSessionStatsAt));
  sessionStatsTimer = setTimeout(() => {
    sessionStatsTimer = null;
    refreshSessionStats();
  }, wait);
  sessionStatsTimer.unref?.();
}

function refreshSessionStats() {
  lastSessionStatsAt = Date.now();
  try {
    const cands = listActiveSessions();
    const next = new Map();
    for (const c of cands) {
      const cached = sessionCache.get(c.full);
      if (cached && cached.mtimeMs === c.mtimeMs) {
        next.set(c.full, cached); // 未变化，复用缓存
      } else {
        const stats = scanSessionFile(c.full);
        if (stats) next.set(c.full, { mtimeMs: c.mtimeMs, stats });
      }
    }
    sessionCache = next;
    const json = JSON.stringify(sessionsList());
    if (json && json !== lastSessionsJson) {
      lastSessionsJson = json;
      post({ type: 'session', sessions: sessionsList() });
    }
  } catch { /* 会话目录不可读时静默，下轮再试 */ }
}

// ---------- 进程扫描 ----------
// 用 Get-CimInstance + JSON（wmic 已废弃且 CSV 不处理命令行里的逗号，会串列）
let lastAppsJson = '';
function matchesProcess(app, names, cmdlines) {
  if (app.procs && app.procs.some(p => names.has(String(p).toLowerCase()))) return true;
  if (app.cmdPatterns && app.cmdPatterns.some(re => cmdlines.some(c => re.test(c)))) return true;
  return false;
}

let processScanBusy = false;

// 进程扫描会启动 PowerShell，单次可能接近 8s 超时；用 busy 标记避免上一轮
// 未结束时下一轮又启动，导致 PowerShell 进程重叠、apps 消息乱序。
async function scanProcesses() {
  if (processScanBusy) return;
  processScanBusy = true;
  try {
    await scanProcessesOnce();
  } finally {
    processScanBusy = false;
  }
}

async function scanProcessesOnce() {
  if (!IS_WIN) return;
  const r = await run('powershell', ['-NoProfile', '-Command',
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Get-CimInstance Win32_Process | Select-Object Name,CommandLine | ConvertTo-Json -Compress']);
  let procs = [];
  try { procs = JSON.parse(r.stdout || '[]'); } catch { procs = []; }
  if (!Array.isArray(procs)) procs = [procs];
  const names = new Set();
  const cmdlines = [];
  for (const p of procs) {
    if (!p || !p.Name) continue;
    names.add(String(p.Name).toLowerCase());
    if (p.CommandLine) cmdlines.push(String(p.CommandLine).toLowerCase());
  }
  // Claude Code：命令行含独立 claude 词（CLI 名）
  const claudeCodeRunning = cmdlines.some(c => /(^|[/\\="\s])claude(["\s/\\]|$)/.test(c))
    || names.has('claude.exe') || names.has('claude');
  // Codex（ChatGPT 桌面版）：ChatGPT.exe 或 Codex.exe
  const codexRunning = names.has('chatgpt.exe') || names.has('codex.exe');

  // 并行探测，避免新增多个 HTTP 应用后每轮 8s 被串行 1.2s 超时拖慢
  const next = await Promise.all(APPS.map(async (app) => {
    let running = false;
    if (app.kind === 'log' && app.id === 'claude-code') running = claudeCodeRunning;
    else if (app.kind === 'log' && app.id === 'codex') running = codexRunning;
    if (matchesProcess(app, names, cmdlines)) running = true;

    let probeInfo = null;
    if (app.probe && (!app.probeWithProcOnly || running)) {
      probeInfo = await probeHttp(app.probe);
    }
    if (probeInfo?.ok) running = true;

    if (running) {
      if (probeInfo?.ok) appInfo.set(app.id, { models: probeInfo.models, total: probeInfo.modelCount });
      else appInfo.delete(app.id);
      // 在线时：tasking 状态由日志 adapter 维护，这里只做 offline 检测和兜底
      const cur = appStatus.get(app.id);
      const status = cur === 'tasking' ? 'tasking' : 'online';
      appStatus.set(app.id, status);
      return publicApp(app, status);
    }

    // 进程退出：任务必已结束，同步复位 busy 防止「幽灵 tasking」
    appInfo.delete(app.id);
    if (app.id === 'claude-code' && busy) busy = false;
    if (app.id === 'codex' && codexBusy) codexBusy = false;
    appStatus.set(app.id, 'offline');
    return publicApp(app, 'offline');
  }));

  const json = JSON.stringify(next.map(a => ({ id: a.id, status: a.status, detail: a.detail })));
  if (json !== lastAppsJson) {
    lastAppsJson = json;
    post({ type: 'apps', apps: next });
  }
}

async function probeHttp(probe) {
  const url = typeof probe === 'string' ? probe : probe && probe.url;
  if (!url) return { ok: false, models: [] };
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
    if (!res.ok) return { ok: false, models: [], modelCount: 0 };
    let data = null;
    try { data = await res.json(); } catch { /* 非 JSON 也认为在线 */ }
    const info = extractModelInfo(data);
    return { ok: true, models: info.names, modelCount: info.total };
  } catch {
    return { ok: false, models: [], modelCount: 0 };
  }
}

// ---------- Claude Code 日志 adapter ----------
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
let logFile = null;            // 当前跟踪的会话文件
const logOffsets = new Map();  // path → 已读字节偏移（会话来回切换不重放历史）
let logRemainder = '';         // 跨轮次的不完整行尾（写一半的 jsonl 行）
let busy = false;              // claude-code 任务中
let busySince = 0;             // tasking 起始时刻（看门狗用）
let lastLogActivity = 0;       // 最近一次读到新日志行的时刻
const BUSY_TIMEOUT_MS = 3 * 60 * 1000; // 看门狗：3 分钟无日志推进视为任务结束（result 事件可能丢失）

function findNewestSession() {
  try {
    let newest = null;
    for (const proj of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
      if (!proj.isDirectory()) continue;
      const dir = path.join(CLAUDE_DIR, proj.name);
      // 单个目录不可读（权限）只跳过该目录，不中断整体扫描
      let files;
      try { files = fs.readdirSync(dir); } catch { continue; }
      for (const f of files) {
        if (!f.endsWith('.jsonl')) continue;
        const full = path.join(dir, f);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { full, mtimeMs: st.mtimeMs };
      }
    }
    return newest;
  } catch { return null; }
}

function pollClaudeLog() {
  try {
    // 会话切换：出现了更新的 jsonl → 跟踪新文件（偏移按文件记忆，切回不重放）
    const cand = findNewestSession();
    if (cand && (!logFile || cand.full !== logFile)) {
      logFile = cand.full;
      logRemainder = '';
    }
    if (!logFile) return;
    // 一次 open+fstat：文件被删/被锁（ENOENT/EPERM）直接返回，不崩 host
    let fd, st;
    try {
      fd = fs.openSync(logFile, 'r');
      st = fs.fstatSync(fd);
    } catch {
      if (fd) try { fs.closeSync(fd); } catch { /* 已关 */ }
      return;
    }
    try {
      const offset = logOffsets.get(logFile) || 0;
      if (st.size <= offset) return;
      const chunk = Buffer.alloc(st.size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      const text = logRemainder + chunk.toString('utf8');
      // 只推进到最后一个换行边界：写了一半的行留到下一轮拼
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) { logRemainder = text; return; }
      logRemainder = text.slice(lastNl + 1);
      const complete = text.slice(0, lastNl);
      logOffsets.set(logFile, offset + chunk.length);
      if (complete.trim()) lastLogActivity = Date.now();
      for (const line of complete.split(/\r?\n/)) {
        const ev = parseClaudeLine(line);
        if (ev) emitMessage(ev);
      }
      // 日志有推进 → 节流刷新会话统计（token/模型随输出更新）
      scheduleSessionStats();
    } finally {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
  } catch { /* 单轮失败不影响下轮 */ }
}

function parseClaudeLine(line) {
  if (!line.trim()) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o.type === 'assistant' && o.message && Array.isArray(o.message.content)) {
    const text = o.message.content.filter(c => c && c.type === 'text').map(c => c.text).join('\n').trim();
    if (text) return { app: 'claude-code', role: 'assistant', text: text.slice(0, 4000), done: false, ts: o.timestamp || '' };
  }
  if (o.type === 'user' && o.message) {
    const c = o.message.content;
    const text = typeof c === 'string'
      ? c
      : (Array.isArray(c) ? c.filter(x => x && x.type === 'text').map(x => x.text).join('\n') : '');
    if (text && !text.startsWith('<')) return { app: 'claude-code', role: 'user', text: text.slice(0, 2000), done: false, ts: o.timestamp || '' };
  }
  if (o.type === 'result') {
    const dur = o.duration_ms ? `，耗时 ${Math.round(o.duration_ms / 1000)}s` : '';
    return { app: 'claude-code', role: 'system', text: `任务完成（${o.subtype || 'success'}${dur}）`, done: true, ts: o.timestamp || '' };
  }
  return null;
}

function emitMessage(ev) {
  recent.push(ev);
  if (recent.length > 50) recent.splice(0, recent.length - 50);
  if (ev.app === 'claude-code') {
    // 状态转移：result(done) → 结束；assistant → 任务中；user 只在非任务中时开启新任务
    // （任务中的 user 行是工具结果回传，不改变状态）
    if (ev.done) busy = false;
    else if (ev.role === 'assistant') { if (!busy) busySince = Date.now(); busy = true; }
    else if (ev.role === 'user' && !busy) { busySince = Date.now(); busy = true; }
    if (appStatus.get('claude-code') !== (busy ? 'tasking' : 'online')) {
      appStatus.set('claude-code', busy ? 'tasking' : 'online');
      post({ type: 'apps', apps: currentAppsList() }); // 状态变化即时推，不等下轮进程扫描
    }
  }
  if (ev.app === 'codex') {
    // task_complete(done) → 结束；user_message / agent_message → 任务中
    if (ev.done) codexBusy = false;
    else codexBusy = true;
    if (appStatus.get('codex') !== (codexBusy ? 'tasking' : 'online')) {
      appStatus.set('codex', codexBusy ? 'tasking' : 'online');
      post({ type: 'apps', apps: currentAppsList() });
    }
  }
  post({ type: 'message', ...ev });
}

// 看门狗：tasking 超过 3 分钟且日志无任何推进 → result 丢失，强制视为完成。
// （Claude Code 长任务每秒都会写日志行；3 分钟完全静默只可能是事件丢失或进程已退出）
function checkBusyWatchdog() {
  if (!busy) return;
  const idle = Date.now() - Math.max(lastLogActivity, busySince);
  if (idle > BUSY_TIMEOUT_MS) {
    busy = false;
    appStatus.set('claude-code', 'online');
    post({ type: 'apps', apps: currentAppsList() });
  }
}

// 组装当前应用状态列表（apps 事件与 snapshot 共用）
function publicApp(app, status) {
  const info = appInfo.get(app.id);
  return {
    id: app.id,
    name: app.name,
    status,
    detail: formatAppDetail(app.detail, info && info.models, info && info.total),
  };
}

function currentAppsList() {
  return APPS.map(app => publicApp(app, appStatus.get(app.id) || 'offline'));
}

// ---------- Codex（ChatGPT 桌面版）日志 adapter ----------
// 会话日志：~/.codex/sessions/YYYY/MM/DD/rollout-<date>-<sessionId>.jsonl
// 行结构 {timestamp, type, payload}，与 Claude 的 tailed adapter 同套路：
// 找最新 rollout 文件 → 按字节偏移增量读 → 只解析 event_msg 中对 UI 有意义的子集。
const CODEX_DIR = path.join(os.homedir(), '.codex', 'sessions');
let codexFile = null;            // 当前跟踪的会话文件
const codexOffsets = new Map();  // path → 已读字节偏移
let codexRemainder = '';
let codexBusy = false;           // codex 任务中

function findNewestCodexSession() {
  try {
    let newest = null;
    for (const cand of collectJsonlCandidates(CODEX_DIR, 0, 3)) {
      if (!path.basename(cand.full).startsWith('rollout-')) continue;
      if (!newest || cand.mtimeMs > newest.mtimeMs) newest = cand;
    }
    return newest;
  } catch { return null; }
}

function pollCodexLog() {
  try {
    const cand = findNewestCodexSession();
    if (cand && (!codexFile || cand.full !== codexFile)) {
      codexFile = cand.full;
      codexRemainder = '';
    }
    if (!codexFile) return;
    let fd, st;
    try {
      fd = fs.openSync(codexFile, 'r');
      st = fs.fstatSync(fd);
    } catch {
      if (fd) try { fs.closeSync(fd); } catch { /* 已关 */ }
      return;
    }
    try {
      const offset = codexOffsets.get(codexFile) || 0;
      if (st.size <= offset) return;
      const chunk = Buffer.alloc(st.size - offset);
      fs.readSync(fd, chunk, 0, chunk.length, offset);
      const text = codexRemainder + chunk.toString('utf8');
      const lastNl = text.lastIndexOf('\n');
      if (lastNl < 0) { codexRemainder = text; return; }
      codexRemainder = text.slice(lastNl + 1);
      const complete = text.slice(0, lastNl);
      codexOffsets.set(codexFile, offset + chunk.length);
      for (const line of complete.split(/\r?\n/)) {
        const ev = parseCodexLine(line);
        if (ev) emitMessage(ev);
      }
      // 日志有推进 → 节流刷新会话统计（token/模型随输出更新）
      scheduleSessionStats();
    } finally {
      try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
  } catch { /* 单轮失败不影响下轮 */ }
}

function parseCodexLine(line) {
  if (!line.trim()) return null;
  let o;
  try { o = JSON.parse(line); } catch { return null; }
  if (o.type !== 'event_msg' || !o.payload) return null;
  const p = o.payload;
  const ts = o.timestamp || '';
  switch (p.type) {
    case 'user_message': {
      const text = String(p.message || '').trim();
      if (!text) return null;
      return { app: 'codex', role: 'user', text: text.slice(0, 2000), done: false, ts };
    }
    case 'agent_message': {
      const text = String(p.message || '').trim();
      if (!text) return null;
      return { app: 'codex', role: 'assistant', text: text.slice(0, 4000), done: false, ts };
    }
    case 'task_complete': {
      const dur = p.duration_ms ? `，耗时 ${Math.round(p.duration_ms / 1000)}s` : '';
      return { app: 'codex', role: 'system', text: `任务完成${dur}`, done: true, ts };
    }
    default:
      return null; // agent_reasoning / token_count 等只入统计，不进消息流
  }
}

// ---------- 弹窗检测（UIA） ----------
let dialogScanBusy = false;
async function scanDialogs() {
  if (!IS_WIN || dialogScanBusy) return;
  dialogScanBusy = true;
  try {
    const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HOST_DIR, 'dialogs.ps1')]);
    if (r.code !== 0) return;
    const list = JSON.parse(r.stdout || '[]');
    const seen = new Set();
    for (const d of (Array.isArray(list) ? list : [list])) {
      if (!d || !d.hwnd) continue;
      seen.add(d.hwnd);
      if (!openDialogs.has(d.hwnd)) {
        const dlg = { id: d.hwnd, app: d.process, title: d.title, buttons: d.buttons || [] };
        openDialogs.set(d.hwnd, dlg);
        post({ type: 'dialog', ...dlg });
      }
    }
    // 消失的弹窗 → 关闭事件
    for (const [hwnd] of openDialogs) {
      if (!seen.has(hwnd)) {
        openDialogs.delete(hwnd);
        post({ type: 'dialog:closed', id: hwnd });
      }
    }
  } catch { /* PS 不可用时静默 */ }
  finally { dialogScanBusy = false; }
}

async function clickDialog(dialogId, buttonId) {
  if (!IS_WIN) return;
  const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(HOST_DIR, 'dialog-click.ps1'), '-Hwnd', String(dialogId), '-ButtonId', String(buttonId || '')]);
  if (r.code === 0 && openDialogs.has(dialogId)) {
    openDialogs.delete(dialogId);
    post({ type: 'dialog:closed', id: dialogId });
  }
}

// ---------- 子进程工具 ----------
function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let stdout = '', stderr = '';
    p.stdout && p.stdout.on('data', c => { stdout += c; });
    p.stderr && p.stderr.on('data', c => { stderr += c; });
    p.on('error', () => resolve({ code: -1, stdout: '', stderr: '' }));
    p.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    // PowerShell/wmic 偶发卡死保护
    setTimeout(() => { try { p.kill(); } catch { /* 已退出 */ } }, 8000).unref();
  });
}

// ---------- 系统资源监视（sysmon.ps1 轮询） ----------
// 只有页面在线时才需要高频刷新；没有订阅时降频到 15s 省 CPU（sysmon.ps1 单次 ~1.6s）。
// 高频也从 3s 降到 5s，避免 PowerShell 常驻占用。
let sysmonBusy = false;
let sysmonTimer = null;
let sysmonFast = false; // 页面请求快速模式（ai:subscribe 时开）
let lastSys = null;

async function pollSysmon() {
  if (!IS_WIN || sysmonBusy) return;
  sysmonBusy = true;
  try {
    const r = await run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(HOST_DIR, 'sysmon.ps1')]);
    if (r.code === 0 && r.stdout) {
      const metrics = JSON.parse(r.stdout);
      // 数值清洗：null/undefined 保留（面板显示「不支持」），其余转数字
      lastSys = metrics;
      post({ type: 'sys', metrics });
    }
  } catch { /* 单轮失败静默 */ }
  finally { sysmonBusy = false; }
}

function scheduleSysmon() {
  clearInterval(sysmonTimer);
  const period = sysmonFast ? SYSMON_FAST_MS : SYSMON_SLOW_MS;
  sysmonTimer = setInterval(pollSysmon, period);
  sysmonTimer.unref();
}

function setSysmonFast(fast) {
  if (sysmonFast === fast) return;
  sysmonFast = fast;
  scheduleSysmon();
  if (fast) pollSysmon(); // 切快速时立即采一轮
}

// ---------- 主循环 ----------
// 轮询节奏：进程扫描 8s、日志 1.5s、弹窗 10s、看门狗 30s、sysmon 5s（无页面订阅 15s）
// ——每轮都要拉起 PowerShell（进程开销大），全 .unref() 让空转不阻止退出。
scanProcesses();
pollClaudeLog();
pollCodexLog();
refreshSessionStats(); // 启动即推一次会话统计（页面打开即有数据）
pollSysmon();
setInterval(scanProcesses, PROCESS_SCAN_INTERVAL_MS).unref();
setInterval(pollClaudeLog, LOG_POLL_INTERVAL_MS).unref();
setInterval(pollCodexLog, LOG_POLL_INTERVAL_MS).unref();
setInterval(scanDialogs, DIALOG_SCAN_INTERVAL_MS).unref(); // 弹窗是低频事件，10s 足够灵敏
setInterval(checkBusyWatchdog, 30000).unref();
scheduleSysmon();
post({ type: 'host:ready' });
