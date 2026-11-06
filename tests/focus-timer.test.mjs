// 回归测试：番茄钟/便利贴任务注册、默认状态与状态迁移
import test from 'node:test';
import assert from 'node:assert/strict';
import focusTimer from '../newtab/js/widgets/focusTimer.js';
import { DEFAULT_STATE, migrateState } from '../newtab/js/store.js';

const NEW_WIDGET_KEYS = ['githubWorkbench', 'aiCost', 'dependencyRadar', 'promptVault', 'devServices'];

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

test('默认新增 5 个工作组，全部为 M，且番茄钟在最后', () => {
  for (const key of NEW_WIDGET_KEYS) {
    const widget = DEFAULT_STATE.widgets.find(w => w.key === key);
    assert.ok(widget, `缺少 ${key}`);
    assert.equal(widget.size, 'm', `${key} 默认尺寸应为 m`);
  }
  assert.equal(DEFAULT_STATE.widgets.at(-1).key, 'focusTimer');
  assert.equal(DEFAULT_STATE.settings.schemaVersion, 12);
});

test('v7 状态迁移会追加 focusTimer/stickyTasks，并把番茄钟移到最后', () => {
  const old = {
    settings: { schemaVersion: 7, theme: 'light' },
    widgets: [
      { id: 'w-search', key: 'search', size: 'l', data: {} },
      { id: 'w-music', key: 'music', size: 'm', data: {} },
    ],
  };
  const migrated = migrateState(old);
  assert.equal(migrated.settings.schemaVersion, 12);
  assert.deepEqual(migrated.widgets.map(w => w.key), [
    'search', 'music', 'stickyTasks', 'javaNotes', 'githubRanking',
    ...NEW_WIDGET_KEYS, 'focusTimer',
  ]);
  const focus = migrated.widgets.find(w => w.key === 'focusTimer');
  assert.equal(focus.data.minutes, 25);
  const sticky = migrated.widgets.find(w => w.key === 'stickyTasks');
  assert.equal(sticky.data.showLimit, 10);
});

test('v8 状态缺失 stickyTasks 时补回，已有组件不重复添加', () => {
  const missing = {
    settings: { schemaVersion: 8, theme: 'light' },
    widgets: [{ id: 'w-search', key: 'search', size: 'l', data: {} }],
  };
  const migrated = migrateState(missing);
  assert.equal(migrated.settings.schemaVersion, 12);
  assert.deepEqual(migrated.widgets.map(w => w.key), [
    'search', 'stickyTasks', 'javaNotes', 'githubRanking', ...NEW_WIDGET_KEYS,
  ]);

  const existing = {
    settings: { schemaVersion: 8, theme: 'light' },
    widgets: [
      { id: 'w-search', key: 'search', size: 'l', data: {} },
      { id: 'w-tasks', key: 'stickyTasks', size: 'm', data: { showLimit: 5 } },
    ],
  };
  const migratedExisting = migrateState(existing);
  assert.equal(migratedExisting.settings.schemaVersion, 12);
  assert.deepEqual(migratedExisting.widgets.map(w => w.key), [
    'search', 'stickyTasks', 'javaNotes', 'githubRanking', ...NEW_WIDGET_KEYS,
  ]);
  assert.equal(migratedExisting.widgets[1].data.showLimit, 5);
});

test('v10 状态迁移会追加 GitHub 星级榜和 5 个工作组', () => {
  const old = {
    settings: { schemaVersion: 10, theme: 'light' },
    widgets: [
      { id: 'w-search', key: 'search', size: 'l', data: {} },
      { id: 'w-java-notes', key: 'javaNotes', size: 'm', data: {} },
    ],
  };
  const migrated = migrateState(old);
  assert.equal(migrated.settings.schemaVersion, 12);
  assert.deepEqual(migrated.widgets.map(w => w.key), [
    'search', 'javaNotes', 'githubRanking', ...NEW_WIDGET_KEYS,
  ]);
  assert.equal(migrated.widgets.find(w => w.key === 'githubRanking').size, 'm');
});

test('v11 状态迁移只追加工作组，并把已有番茄钟移到最后', () => {
  const old = {
    settings: { schemaVersion: 11, theme: 'light' },
    widgets: [
      { id: 'w-search', key: 'search', size: 'l', data: {} },
      { id: 'w-focus', key: 'focusTimer', size: 'm', data: { minutes: 45 } },
      { id: 'w-github', key: 'githubRanking', size: 'm', data: {} },
    ],
  };
  const migrated = migrateState(old);
  assert.equal(migrated.settings.schemaVersion, 12);
  assert.deepEqual(migrated.widgets.map(w => w.key), [
    'search', 'githubRanking', ...NEW_WIDGET_KEYS, 'focusTimer',
  ]);
  assert.equal(migrated.widgets.at(-1).data.minutes, 45);
});

test('已是 v12 的状态不重复迁移', () => {
  const current = {
    settings: { schemaVersion: 12, theme: 'light' },
    widgets: [
      { id: 'w-search', key: 'search', size: 'l', data: {} },
      { id: 'w-java-notes', key: 'javaNotes', size: 'm', data: {} },
    ],
  };
  assert.equal(migrateState(current), null);
});
