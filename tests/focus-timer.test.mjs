// 回归测试：番茄钟注册/默认状态/v7→v8 迁移
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

test('默认布局包含 focusTimer', () => {
  const w = DEFAULT_STATE.widgets.find(x => x.key === 'focusTimer');
  assert.ok(w);
  assert.equal(w.size, 'm');
});

test('v7 状态迁移会追加 focusTimer，且不改变已有顺序', () => {
  const old = {
    settings: { schemaVersion: 7, theme: 'light' },
    widgets: [
      { id: 'w-search', key: 'search', size: 'l', data: {} },
      { id: 'w-music', key: 'music', size: 'm', data: {} },
    ],
  };
  const migrated = migrateState(old);
  assert.equal(migrated.settings.schemaVersion, 8);
  assert.deepEqual(migrated.widgets.map(w => w.key), ['search', 'music', 'focusTimer']);
  assert.equal(migrated.widgets[2].data.minutes, 25);
});

test('已是 v8 的状态不重复迁移', () => {
  const current = {
    settings: { schemaVersion: 8, theme: 'light' },
    widgets: [{ id: 'w-search', key: 'search', size: 'l', data: {} }],
  };
  assert.equal(migrateState(current), null);
});
