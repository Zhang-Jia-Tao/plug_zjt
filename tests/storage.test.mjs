// 回归测试：便利贴存储的并发写、导入备份/恢复
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  getAllNotes,
  saveNote,
  toggleTask,
  replaceAllNotes,
  getBackupInfo,
  restoreBackup,
} from '../extension/lib/store.js';
import { extractImportNotes, extractNotesFromBackup } from '../extension/lib/import.js';

function makeChrome(initial = {}) {
  const data = structuredClone(initial);
  return {
    data,
    chrome: {
      storage: {
        local: {
          async get(key) {
            await new Promise(r => setTimeout(r, 2));
            if (typeof key === 'string') return { [key]: data[key] };
            return { ...data };
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

async function withChrome(chrome, fn) {
  const prev = globalThis.chrome;
  globalThis.chrome = chrome;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete globalThis.chrome;
    else globalThis.chrome = prev;
  }
}

test('导入解析兼容 notes / json.notes，空数组会被拒绝', () => {
  assert.deepEqual(extractImportNotes({ notes: [{ id: 'a' }] }), [{ id: 'a' }]);
  assert.deepEqual(extractImportNotes({ json: { notes: [{ id: 'b' }] } }), [{ id: 'b' }]);
  assert.deepEqual(extractImportNotes({ json: [{ id: 'd' }] }), [{ id: 'd' }]);
  assert.deepEqual(extractNotesFromBackup([{ id: 'c' }]), [{ id: 'c' }]);
  assert.throws(() => extractImportNotes({ notes: [] }), /没有便利贴/);
  assert.throws(() => extractImportNotes({}), /格式不正确/);
});

test('并发 saveNote 不丢更新', async () => {
  const m = makeChrome();
  await withChrome(m.chrome, async () => {
    await Promise.all([
      saveNote({ id: 'a', title: 'A' }),
      saveNote({ id: 'b', title: 'B' }),
    ]);
    const notes = await getAllNotes();
    assert.deepEqual(notes.map(n => n.id).sort(), ['a', 'b']);
  });
});

test('toggleTask 与 saveNote 并发不互相覆盖', async () => {
  const m = makeChrome({
    notes: [
      { id: 'a', title: 'A', category: 'task_list', tasks: [{ id: 't1', title: 'T', done: false }] },
    ],
  });
  await withChrome(m.chrome, async () => {
    await Promise.all([
      toggleTask('a', 't1'),
      saveNote({ id: 'b', title: 'B' }),
    ]);
    const notes = await getAllNotes();
    assert.equal(notes.find(n => n.id === 'a').tasks[0].done, true);
    assert.ok(notes.find(n => n.id === 'b'));
  });
});

test('破坏性替换会先备份，且可以恢复', async () => {
  const m = makeChrome();
  await withChrome(m.chrome, async () => {
    await replaceAllNotes([{ id: 'a', title: 'A', category: 'url' }]);
    await replaceAllNotes(
      [{ id: 'b', title: 'B', category: 'url' }],
      { reason: 'import', allowEmpty: false }
    );

    const info = await getBackupInfo();
    assert.equal(info.count, 1);
    assert.equal(info.reason, 'import');

    const restored = await restoreBackup();
    assert.equal(restored.restored, 1);
    const notes = await getAllNotes();
    assert.deepEqual(notes.map(n => n.id), ['a']);
  });
});

test('replaceAllNotes 默认拒绝空数组覆盖（当 allowEmpty=false）', async () => {
  const m = makeChrome({ notes: [{ id: 'a' }] });
  await withChrome(m.chrome, async () => {
    await assert.rejects(
      () => replaceAllNotes([], { reason: 'import', allowEmpty: false }),
      /空数据/
    );
    const notes = await getAllNotes();
    assert.deepEqual(notes.map(n => n.id), ['a']);
  });
});
