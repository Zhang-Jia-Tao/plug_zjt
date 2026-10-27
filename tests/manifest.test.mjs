// 回归测试：跨扩展白名单必须与新标签页扩展 ID 一致，且不允许通配
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(root, rel), 'utf8'));

test('便利贴扩展只允许新标签页扩展接入', () => {
  const ext = readJson('extension/manifest.json');
  const host = readJson('ai_manager_host/com.zjt.ai_manager.json');
  const expectedId = host.allowed_origins[0]
    .replace(/^chrome-extension:\/\//, '')
    .replace(/\/$/, '');

  assert.deepEqual(ext.externally_connectable.ids, [expectedId]);
  assert.equal(ext.externally_connectable.matches, undefined);
  assert.ok(!ext.externally_connectable.ids.includes('*'));
});

test('三个扩展 manifest 版本号可解析', () => {
  for (const rel of ['manifest.json', 'extension/manifest.json', 'newtab/manifest.json']) {
    const m = readJson(rel);
    assert.match(m.version, /^\d+\.\d+\.\d+$/);
  }
});
