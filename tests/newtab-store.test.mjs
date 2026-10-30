// 回归测试：两个新标签页窗口同时保存时，不互相覆盖对方新增的组件/设置
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadState, saveState } from '../newtab/js/store.js';

function makeChrome(initial) {
  const data = structuredClone(initial);
  return {
    data,
    chrome: {
      storage: {
        local: {
          async get(key) {
            await new Promise(r => setTimeout(r, 2));
            return typeof key === 'string' ? { [key]: data[key] } : { ...data };
          },
          async set(obj) {
            await new Promise(r => setTimeout(r, 2));
            Object.assign(data, structuredClone(obj));
          },
        },
      },
    },
  };
}

test('保存时合并其他窗口的组件和设置，而不是整份旧状态覆盖', async () => {
  const initial = {
    newtab_state: {
      settings: { schemaVersion: 9, theme: 'light', stickyExtId: '' },
      widgets: [{ id: 'w-base', key: 'search', size: 'l', data: {} }],
      _revision: 0,
    },
  };
  const m = makeChrome(initial);
  const prev = globalThis.chrome;
  globalThis.chrome = m.chrome;
  try {
    const state = await loadState();

    // 模拟另一个新标签页窗口先保存：主题变深 + 新增一个组件。
    m.data.newtab_state = {
      settings: { ...initial.newtab_state.settings, theme: 'dark' },
      widgets: [
        ...initial.newtab_state.widgets,
        { id: 'w-other', key: 'topSites', size: 'm', data: {} },
      ],
      _revision: 1,
    };

    // 当前窗口只改了自己关心的 stickyExtId，并新增本地组件。
    const baseWidget = state.widgets.find(w => w.id === 'w-base');
    const baseData = baseWidget.data;
    state.settings.stickyExtId = 'sticky-id';
    state.widgets.push({ id: 'w-local', key: 'music', size: 'm', data: {} });
    await saveState(state);

    // 合并结果原地回写：设置对象保留，组件 data 对象身份也保留。
    assert.equal(state.settings.theme, 'dark');
    assert.equal(state.widgets.find(w => w.id === 'w-base').data, baseData);

    const saved = m.data.newtab_state;
    assert.equal(saved.settings.theme, 'dark');       // 没改的字段保留其他窗口的值
    assert.equal(saved.settings.stickyExtId, 'sticky-id');
    assert.deepEqual(
      saved.widgets.map(w => w.id).sort(),
      ['w-base', 'w-local', 'w-other']               // 双方新增的组件都在
    );
    assert.equal(saved._revision, 2);

    // 当前页面仍持有旧快照（没有 w-other）；再次保存不能把对方的组件当成删除。
    state.settings.stickyExtId = 'sticky-id-2';
    await saveState(state);
    assert.deepEqual(
      m.data.newtab_state.widgets.map(w => w.id).sort(),
      ['w-base', 'w-local', 'w-other']
    );
    assert.equal(m.data.newtab_state.settings.stickyExtId, 'sticky-id-2');
  } finally {
    if (prev === undefined) delete globalThis.chrome;
    else globalThis.chrome = prev;
  }
});

test('loadState 会把旧 schema 迁移结果整体写回', async () => {
  const m = makeChrome({
    newtab_state: {
      settings: { schemaVersion: 7, theme: 'light' },
      widgets: [{ id: 'w-search', key: 'search', size: 'l', data: {} }],
    },
  });
  const prev = globalThis.chrome;
  globalThis.chrome = m.chrome;
  try {
    const loaded = await loadState();
    assert.equal(loaded.settings.schemaVersion, 9);
    assert.ok(loaded.widgets.some(w => w.key === 'focusTimer'));
    const saved = m.data.newtab_state;
    assert.equal(saved.settings.schemaVersion, 9);
    assert.ok(saved.widgets.some(w => w.key === 'focusTimer'));
  } finally {
    if (prev === undefined) delete globalThis.chrome;
    else globalThis.chrome = prev;
  }
});
