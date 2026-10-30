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
