// 回归测试：网页 AI 站点注册表、host 匹配与 manifest 注入覆盖
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WEB_AI_SITES, matchWebAiSite, webAiSiteById } from '../newtab/js/webai-sites.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'newtab/manifest.json'), 'utf8'));
const webScript = manifest.content_scripts.find(cs => (cs.js || []).includes('content-webai.js'));

test('网页 AI 注册表字段合法且不重复', () => {
  assert.ok(WEB_AI_SITES.length >= 5);
  const ids = new Set();
  const hosts = new Set();
  for (const site of WEB_AI_SITES) {
    assert.ok(site.id && !ids.has(site.id), `重复 id: ${site.id}`);
    ids.add(site.id);
    assert.ok(site.name, `${site.id} 缺少 name`);
    assert.match(site.color, /^#[0-9a-f]{6}$/i, `${site.id} 颜色格式错误`);
    assert.ok(site.short && site.short.length <= 3, `${site.id} short 过长`);
    for (const host of site.hosts) {
      assert.ok(!hosts.has(host), `重复 host: ${host}`);
      hosts.add(host);
    }
  }
});

test('按域名匹配，支持子域但拒绝后缀仿冒', () => {
  assert.equal(matchWebAiSite('chatgpt.com')?.id, 'chatgpt');
  assert.equal(matchWebAiSite('chat.openai.com')?.id, 'chatgpt');
  assert.equal(matchWebAiSite('foo.claude.ai')?.id, 'claude');
  assert.equal(matchWebAiSite('www.kimi.com')?.id, 'kimi');
  assert.equal(matchWebAiSite('notclaude.ai'), null);
  assert.equal(matchWebAiSite('evilclaude.ai'), null);
  assert.equal(matchWebAiSite(''), null);
  assert.equal(webAiSiteById('gemini')?.name, 'Gemini');
  assert.equal(webAiSiteById('unknown'), null);
});

test('manifest 的 content-webai 覆盖注册表全部宿主域名', () => {
  assert.ok(webScript, 'manifest 缺少 content-webai.js content script');
  const patterns = webScript.matches.map(m => m.replace(/^https?:\/\//, '').replace(/\/.*$/, ''));
  for (const site of WEB_AI_SITES) {
    for (const host of site.hosts) {
      assert.ok(
        patterns.includes(host) || patterns.includes('*.' + host),
        `${host} 没有对应的 content script match`,
      );
    }
  }
});

test('网页 AI 采集脚本只上报状态，不读取聊天正文', () => {
  const src = fs.readFileSync(path.join(root, 'newtab/content-webai.js'), 'utf8');
  assert.ok(src.includes("action: 'ai:web-state'"));
  assert.ok(src.includes('document.visibilityState'));
  assert.ok(!src.includes('innerText'));
  // textContent 仅用于识别 Stop 按钮文字，不能把消息正文写进上报对象
  const payload = src.match(/return \{[\s\S]*?host:[\s\S]*?\};/);
  assert.ok(payload, '找不到 snapshot 返回对象');
  assert.ok(!/textContent|innerText/.test(payload[0]));
});

test('网页 AI 采集避免监听全页 characterData，并为兜底扫描/僵尸状态加限制', () => {
  const src = fs.readFileSync(path.join(root, 'newtab/content-webai.js'), 'utf8');
  assert.ok(!src.includes('characterData: true'));
  assert.ok(src.includes('lastFallbackScan'));
  assert.match(src, /now - lastFallbackScan < 1500/);
  const bg = fs.readFileSync(path.join(root, 'newtab/background.js'), 'utf8');
  assert.match(bg, /WEB_AI_TTL_MS/);
});
