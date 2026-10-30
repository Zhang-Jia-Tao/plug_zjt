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

test('host 清单是可移植模板，安装脚本同时注册 Chrome 与 Edge', () => {
  const host = readJson('ai_manager_host/com.zjt.ai_manager.json');
  assert.equal(host.path, '<HOST_DIR>/run-host.bat');

  const install = fs.readFileSync(path.join(root, 'ai_manager_host/install-host.bat'), 'utf8');
  assert.match(install, /com\.zjt\.ai_manager\.local\.json/);
  assert.match(install, /Software\\Google\\Chrome\\NativeMessagingHosts/);
  assert.match(install, /Software\\Microsoft\\Edge\\NativeMessagingHosts/);

  const gitignore = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  assert.match(gitignore, /com\.zjt\.ai_manager\.local\.json/);
});
