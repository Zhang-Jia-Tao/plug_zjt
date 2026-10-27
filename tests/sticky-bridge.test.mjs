// 回归测试：新标签页 → 便利贴扩展的桥接超时/错误映射
import test from 'node:test';
import assert from 'node:assert/strict';
import { sendToSticky } from '../newtab/js/bridge.js';

function withChrome(mock, fn) {
  const prev = globalThis.chrome;
  globalThis.chrome = mock;
  return Promise.resolve().then(fn).finally(() => {
    if (prev === undefined) delete globalThis.chrome;
    else globalThis.chrome = prev;
  });
}

test('未配置便利贴扩展 ID 时立即失败', async () => {
  const r = await sendToSticky('', 'getTaskNotes');
  assert.equal(r.ok, false);
  assert.match(r.message, /未配置便利贴扩展 ID/);
});

test('正常转发消息并返回 data', async () => {
  await withChrome({
    runtime: {
      lastError: null,
      sendMessage(id, msg, cb) {
        assert.equal(id, 'sticky-id');
        assert.deepEqual(msg, { action: 'getTaskNotes', payload: {} });
        cb({ ok: true, data: [{ id: 'n1' }] });
      },
    },
  }, async () => {
    const r = await sendToSticky('sticky-id', 'getTaskNotes');
    assert.deepEqual(r, { ok: true, data: [{ id: 'n1' }] });
  });
});

test('lastError 映射为可读提示', async () => {
  await withChrome({
    runtime: {
      lastError: { message: 'Could not establish connection. Receiving end does not exist.' },
      sendMessage(id, msg, cb) { cb(undefined); },
    },
  }, async () => {
    const r = await sendToSticky('sticky-id', 'getTaskNotes');
    assert.equal(r.ok, false);
    assert.match(r.message, /未安装或未开启/);
  });
});

test('来源未授权时提示白名单配置', async () => {
  await withChrome({
    runtime: {
      lastError: null,
      sendMessage(id, msg, cb) { cb({ ok: false, message: '来源未授权' }); },
    },
  }, async () => {
    const r = await sendToSticky('sticky-id', 'getTaskNotes');
    assert.equal(r.ok, false);
    assert.match(r.message, /externally_connectable\.ids/);
  });
});
