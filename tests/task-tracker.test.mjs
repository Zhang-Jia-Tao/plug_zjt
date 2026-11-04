// 回归测试：任务生命周期、阻塞等级、token 增量、完成后计时冻结
import test from 'node:test';
import assert from 'node:assert/strict';
import { zstdCompressSync } from 'node:zlib';
import {
  createTask, applyTaskEvent, tickTask, finishTask, publicTask, TaskTracker,
} from '../ai_manager_host/task-tracker.mjs';
import { scanZstdFrames } from '../ai_manager_host/zstd-frames.mjs';

const base = { app: 'claude-code', id: 's1', project: 'demo', model: 'm', startedAt: 1_000 };

test('等待用户确认是阻塞状态，确认后恢复', () => {
  const t = createTask(base);
  applyTaskEvent(t, { type: 'waiting_user', at: 2_000, label: '允许执行 npm test？' }, 2_000);
  assert.equal(t.phase, 'waiting_user');
  assert.equal(t.blocked.kind, 'waiting_user');
  assert.equal(t.blocked.severity, 'action');
  assert.equal(t.blocked.label, '允许执行 npm test？');
  tickTask(t, 400_000);
  assert.equal(t.done, false, '等待确认时不能被静默自动完成');
  applyTaskEvent(t, { type: 'resume', at: 5_000 }, 5_000);
  assert.equal(t.blocked, null);
});

test('工具 30s 标记较慢，120s 标记可能卡住，tool_result 清掉告警', () => {
  const t = createTask(base);
  applyTaskEvent(t, { type: 'tool_use', at: 2_000, callId: 'c1', name: 'Bash', input: { command: 'npm test' } }, 2_000);
  assert.equal(t.phase, 'tool_running');
  assert.equal(t.action.name, 'Bash');
  tickTask(t, 32_000);
  assert.equal(t.blocked.kind, 'tool_slow');
  tickTask(t, 122_000);
  assert.equal(t.blocked.kind, 'tool_blocked');
  applyTaskEvent(t, { type: 'tool_result', at: 123_000, callId: 'c1', ok: true }, 123_000);
  assert.equal(t.blocked, null);
  assert.equal(t.action.status, 'done');
});

test('长时间没有新输出会标记 no_output，但不会提前伪造完成', () => {
  const t = createTask(base);
  applyTaskEvent(t, { type: 'phase', at: 2_000, phase: 'streaming' }, 2_000);
  tickTask(t, 92_000);
  assert.equal(t.blocked.kind, 'no_output');
  assert.equal(t.done, false);
});

test('token 使用增量累加，上下文取最近一次请求', () => {
  const t = createTask(base);
  applyTaskEvent(t, {
    type: 'usage', at: 2_000,
    usage: { input: 100, cacheRead: 900, output: 40, contextWindow: 10_000 },
  }, 2_000);
  applyTaskEvent(t, {
    type: 'usage', at: 3_000,
    usage: { input: 50, cacheRead: 950, output: 20 },
  }, 3_000);
  assert.equal(t.turn.input, 150);
  assert.equal(t.turn.cacheRead, 1850);
  assert.equal(t.turn.output, 60);
  assert.equal(t.turn.requests, 2);
  assert.equal(t.turn.contextTokens, 1_000);
  assert.equal(t.turn.contextWindow, 10_000);
  assert.equal(t.total.input, 150);
});

test('完成后 duration 冻结，后续 tick/事件不再改变', () => {
  const t = createTask(base);
  finishTask(t, { at: 11_000, outcome: 'completed', durationMs: 10_000 });
  const completed = publicTask(t, 50_000);
  assert.equal(completed.done, true);
  assert.equal(completed.durationMs, 10_000);
  assert.equal(completed.elapsedMs, 10_000);
  tickTask(t, 99_000);
  assert.equal(t.durationMs, 10_000);
  assert.equal(tickTask(t, 100_000), false);
});

test('TaskTracker 历史保留完成记录，并用 historyKey 区分同会话多次任务', () => {
  let now = 1_000;
  const tracker = new TaskTracker({ now: () => now, historyLimit: 2 });
  const a = tracker.start({ ...base, startedAt: 1_000 });
  tracker.apply(a, { type: 'complete', at: 2_000, durationMs: 1_000 });
  const b = tracker.start({ ...base, startedAt: 3_000 });
  tracker.apply(b, { type: 'complete', at: 4_000, durationMs: 1_000 });
  const snap = tracker.snapshot();
  assert.equal(snap.recent.length, 2);
  assert.notEqual(snap.recent[0].historyKey, snap.recent[1].historyKey);
  assert.equal(snap.active.length, 0);
});

test('zstd 多帧扫描能定位每个独立事件帧', () => {
  const frames = [
    zstdCompressSync(Buffer.from('{"type":"turn/start"}\n')),
    zstdCompressSync(Buffer.from('{"type":"turn/end"}\n')),
  ];
  const buffer = Buffer.concat(frames);
  const scan = scanZstdFrames(buffer);
  assert.equal(scan.frames.length, 2);
  assert.equal(scan.frames[0].start, 0);
  assert.equal(scan.frames[1].end, buffer.length);
  const torn = scanZstdFrames(buffer.subarray(0, buffer.length - 3));
  assert.equal(torn.frames.length, 1);
  assert.ok(torn.tornStart > 0);
});
