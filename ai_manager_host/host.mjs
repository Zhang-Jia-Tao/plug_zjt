#!/usr/bin/env node
// host.mjs — 本地 AI 应用管理器 · Chrome Native Messaging host
// 与扩展经 stdio 交换 JSON 帧（4 字节小端长度前缀），Chrome 生命周期管理进程。
// 能力：
//   1. 进程/HTTP 探测本地 AI 应用运行状态（Ollama、LM Studio、Claude 等）
//   2. Claude Code 会话日志（~/.claude/projects/*.jsonl）实时消息 + 任务完成事件
//   3. UIA 枚举白名单进程的模态弹窗（#32770），扩展遥控「确认/否认」
// 协议（host → 扩展）：
//   {type:'apps', apps:[{id,name,status,detail}]}
//   {type:'message', app, role, text, ts, done}
//   {type:'dialog', id, app, title, buttons:[{id,label}]}
//   {type:'dialog:closed', id}
//   {type:'sys', metrics:{cpu,mem,swap,disk,gpu,cpuTemp,gpuTemp,...}}  ← 系统资源轮询
//   {type:'snapshot', apps, dialogs, messages}   ← 响应 {type:'query'}
// 协议（扩展 → host）：
//   {type:'query'} / {type:'dialog:respond', dialogId, buttonId}

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_DIR = path.dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

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
  { id: 'ollama', name: 'Ollama', kind: 'http', procs: ['ollama.exe'], probe: 'http://127.0.0.1:11434/api/tags', detail: '本地 API :11434' },
  { id: 'lmstudio', name: 'LM Studio', kind: 'http', procs: ['lms.exe'], probe: 'http://127.0.0.1:1234/v1/models', detail: '本地 API :1234' },
  { id: 'claude-desktop', name: 'Claude 桌面版', kind: 'proc', procs: ['claude.exe'] },
  { id: 'chatgpt', name: 'ChatGPT 桌面版', kind: 'proc', procs: ['chatgpt.exe'] },
];

const appStatus = new Map();   // id → 'online' | 'tasking' | 'offline'
const recent = [];             // 最近消息（snapshot 回放用，上限 300）
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
  return { type: 'snapshot', apps: appsPart, dialogs: dialogsPart, messages: picked };
}

function handleRequest(msg) {
  switch (msg && msg.type) {
    case 'query':
      post(buildSnapshot());
      if (lastSys) post({ type: 'sys', metrics: lastSys }); // 快照附带当前资源数据
      break;
    case 'sysmon': // 页面开关：有面板订阅时 3s 高频，全部断开后 15s 低频
      setSysmonFast(!!msg.fast);
      break;
    case 'dialog:respond':
      clickDialog(msg.dialogId, msg.buttonId);
      break;
    default:
      post({ type: 'error', message: `未知请求：${msg && msg.type}` });
  }
}

// ---------- 进程扫描 ----------
// 用 Get-CimInstance + JSON（wmic 已废弃且 CSV 不处理命令行里的逗号，会串列）
let lastAppsJson = '';
async function scanProcesses() {
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

  const next = [];
  for (const app of APPS) {
    let running = false;
    if (app.kind === 'log') running = claudeCodeRunning;
    if (app.procs) running = running || app.procs.some(p => names.has(p.toLowerCase()));
    if (app.kind === 'http') running = running || await probeHttp(app.probe);
    if (running) {
      // 在线时：tasking 状态由日志 adapter 维护（emitMessage / 看门狗即时推送），
      // 这里只做 offline 检测和 tasking 的兜底上报
      const cur = appStatus.get(app.id);
      next.push({ ...app, status: cur === 'tasking' ? 'tasking' : 'online' });
    } else {
      // 进程退出：任务必已结束，同步复位 busy 防止「幽灵 tasking」
      if (app.id === 'claude-code' && busy) { busy = false; appStatus.set('claude-code', 'online'); }
      next.push({ ...app, status: 'offline' });
    }
  }
  const json = JSON.stringify(next.map(a => ({ id: a.id, status: a.status })));
  if (json !== lastAppsJson) {
    lastAppsJson = json;
    post({ type: 'apps', apps: next });
  }
}

async function probeHttp(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1200) });
    return res.ok;
  } catch { return false; }
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
  if (recent.length > 300) recent.splice(0, recent.length - 300);
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
function currentAppsList() {
  return APPS.map(app => ({ id: app.id, name: app.name, status: appStatus.get(app.id) || 'offline', detail: app.detail }));
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
  const period = sysmonFast ? 3000 : 15000;
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
// 轮询节奏：进程扫描 6s、日志 1.2s、弹窗 8s、看门狗 30s、sysmon 3s（无页面订阅 15s）
// ——每轮都要拉起 PowerShell（进程开销大），全 .unref() 让空转不阻止退出。
scanProcesses();
pollClaudeLog();
pollSysmon();
setInterval(scanProcesses, 6000).unref();
setInterval(pollClaudeLog, 1200).unref();
setInterval(scanDialogs, 8000).unref(); // 弹窗是低频事件，8s 足够灵敏
setInterval(checkBusyWatchdog, 30000).unref();
scheduleSysmon();
post({ type: 'host:ready' });
