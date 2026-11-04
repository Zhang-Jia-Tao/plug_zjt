// 回归测试：host 轮询不能重叠、会话统计要节流、sysmon 不再 3s 拉 PowerShell
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(root, 'ai_manager_host/host.mjs'), 'utf8');

test('进程扫描有 busy 保护并降到 8s', () => {
  assert.match(src, /let processScanBusy = false/);
  assert.match(src, /if \(processScanBusy\) return/);
  assert.match(src, /PROCESS_SCAN_INTERVAL_MS = 8000/);
  assert.ok(!src.includes('setInterval(scanProcesses, 6000)'));
});

test('会话统计整文件重扫有 5s 节流', () => {
  assert.match(src, /SESSION_STATS_MIN_MS = 5000/);
  assert.match(src, /function scheduleSessionStats\(\)/);
  assert.ok(!src.includes('// 日志有推进 → 同步刷新会话统计'));
});

test('sysmon 高频从 3s 降到 5s，日志轮询 1.5s', () => {
  assert.match(src, /SYSMON_FAST_MS = 5000/);
  assert.match(src, /LOG_POLL_INTERVAL_MS = 1500/);
  assert.ok(!src.includes('sysmonFast ? 3000 : 15000'));
});

test('本机 tasking 不重放历史日志，启动时用日志尾部补活动状态', () => {
  assert.match(src, /if \(!logOffsets\.has\(logFile\)\)/);
  assert.match(src, /if \(!codexOffsets\.has\(codexFile\)\)/);
  assert.match(src, /logOffsets\.set\(logFile, fs\.statSync\(logFile\)\.size\)/);
  assert.match(src, /codexOffsets\.set\(codexFile, fs\.statSync\(codexFile\)\.size\)/);
  assert.match(src, /function claudeActiveFromTail\(file\)/);
  assert.match(src, /function codexActiveFromTail\(file\)/);
  assert.match(src, /STARTUP_ACTIVE_MS = 30_000/);
  assert.match(src, /if \(ev\.role === 'assistant' \|\| ev\.role === 'user'\)/);
  // thinking/tool_use 行没有 text，也必须开启 tasking（真实 Claude Code 很常见）
  assert.match(src, /return \{ app: 'claude-code', role: 'assistant', text: text\.slice/);
  assert.ok(!src.includes("if (text) return { app: 'claude-code'"), 'assistant 无 text 时不能漏掉 tasking');
  assert.ok(!src.includes("ev.role === 'user' && !busy"), '历史用户消息不能直接开启 tasking');
  assert.match(src, /BUSY_TIMEOUT_MS = 45_000/);
  assert.match(src, /function checkCodexBusyWatchdog/);
  assert.match(src, /setInterval\(checkCodexBusyWatchdog, 5000\)/);
});

test('DeepSeek Harness 加入本机监控并能解码 zstd 帧任务事件', () => {
  assert.match(src, /id: 'dsh', name: 'DeepSeek Harness'/);
  assert.match(src, /DSH_DIR = path\.join\(os\.homedir\(\), '\.dsh', 'sessions'\)/);
  assert.match(src, /function findNewestDshSession\(\)/);
  assert.match(src, /function pollDshSessions\(\)/);
  assert.match(src, /setInterval\(pollDshSessions, LOG_POLL_INTERVAL_MS\)/);
  assert.match(src, /function checkDshBusyWatchdog\(\)/);
  assert.match(src, /scanZstdFrames/);
  assert.match(src, /zstdDecompressSync/);
  assert.match(src, /function handleDshEvent/);
  assert.match(src, /case 'turn\/start'/);
  assert.match(src, /case 'tool\/call'/);
  assert.ok(fs.existsSync(path.join(root, 'newtab/img/apps/deepseek.svg')), 'DeepSeek 图标应存在');
});

test('host 任务生命周期覆盖 Claude / Codex / DSH，并推送 tasks 快照', () => {
  assert.match(src, /import \{ TaskTracker \} from '\.\/task-tracker\.mjs'/);
  assert.match(src, /function handleClaudeTaskEvent/);
  assert.match(src, /function handleCodexTaskEvent/);
  assert.match(src, /taskTracker\.start\(/);
  assert.match(src, /taskTracker\.apply\(/);
  assert.match(src, /tasks: tasksSnapshot\(\)/);
  assert.match(src, /setInterval\(\(\) => \{ if \(taskTracker\.tick\(\)\) syncTasks\(\); \}, 5000\)/);
  assert.ok(fs.existsSync(path.join(root, 'ai_manager_host/task-tracker.mjs')));
  assert.ok(fs.existsSync(path.join(root, 'ai_manager_host/zstd-frames.mjs')));
});
