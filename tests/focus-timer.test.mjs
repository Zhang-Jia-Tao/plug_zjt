// 回归测试：番茄钟/便利贴任务注册、默认状态与状态迁移
import test from 'node:test';
import assert from 'node:assert/strict';
import focusTimer from '../newtab/js/widgets/focusTimer.js';
import { DEFAULT_STATE, migrateState } from '../newtab/js/store.js';

test('focusTimer 已注册且默认 25 分钟', () => {
  assert.equal(focusTimer.key, 'focusTimer');
  assert.equal(focusTimer.defaultData.minutes, 25);
  assert.equal(focusTimer.defaultData.remainingMs, 25 * 60 * 1000);
  assert.equal(focusTimer.defaultData.running, false);
});

test('默认布局包含 focusTimer / stickyTasks', () => {
  const focus = DEFAULT_STATE.widgets.find(x => x.key === 'focusTimer');
  assert.ok(focus);
  assert.equal(focus.size, 'm');
  const sticky = DEFAULT_STATE.widgets.find(x => x.key === 'stickyTasks');
  assert.ok(sticky);
  assert.equal(sticky.size, 'm');
});

test('v7 状态迁移会追加 focusTimer/stickyTasks，且不改变已有顺序', () => {
  const old = {
    settings: { schemaVersion: 7, theme: 'light' },
    widgets: [
      { id: 'w-search', key: 'search', size: 'l', data: {} },
      { id: 'w-music', key: 'music', size: 'm', data: {} },
    ],
  };
  const migrated = migrateState(old);
  assert.equal(migrated.settings.schemaVersion, 9);
  assert.deepEqual(migrated.widgets.map(w => w.key), ['search', 'music', 'focusTimer', 'stickyTasks']);
  assert.equal(migrated.widgets[2].data.minutes, 25);
  assert.equal(migrated.widgets[3].data.showLimit, 10);
});

test('v8 状态缺失 stickyTasks 时补回，已有组件不重复添加', () => {
  const missing = {
    settings: { schemaVersion: 8, theme: 'light' },
    widgets: [{ id: 'w-search', key: 'search', size: 'l', data: {} }],
  };
  const migrated = migrateState(missing);
  assert.equal(migrated.settings.schemaVersion, 9);
  assert.deepEqual(migrated.widgets.map(w => w.key), ['search', 'stickyTasks']);

  const existing = {
    settings: { schemaVersion: 8, theme: 'light' },
    widgets: [
      { id: 'w-search', key: 'search', size: 'l', data: {} },
      { id: 'w-tasks', key: 'stickyTasks', size: 'm', data: { showLimit: 5 } },
    ],
  };
  const migratedExisting = migrateState(existing);
  assert.equal(migratedExisting.settings.schemaVersion, 9);
  assert.deepEqual(migratedExisting.widgets.map(w => w.key), ['search', 'stickyTasks']);
  assert.equal(migratedExisting.widgets[1].data.showLimit, 5);
});

test('已是 v9 的状态不重复迁移', () => {
  const current = {
    settings: { schemaVersion: 9, theme: 'light' },
    widgets: [{ id: 'w-search', key: 'search', size: 'l', data: {} }],
  };
  assert.equal(migrateState(current), null);
});
