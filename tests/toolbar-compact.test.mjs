// 回归测试：下滑时工具条收拢系统资源 / AI 面板入口
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');

test('工具条包含收拢入口和面板菜单，并在滚动时切换 compact 状态', () => {
  const html = fs.readFileSync(path.join(root, 'newtab/index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'newtab/css/base.css'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'newtab/js/main.js'), 'utf8');

  assert.ok(html.includes('id="btn-tool-more"'));
  assert.ok(html.includes('id="tool-more-menu"'));
  assert.ok(html.includes('data-panel="sys"'));
  assert.ok(html.includes('data-panel="ai"'));
  assert.match(html, /class="tool-more-menu hidden"/);

  assert.ok(css.includes('.toolbar.is-compact'));
  assert.ok(css.includes('.tool-more-toggle'));
  assert.ok(css.includes('.tool-more-menu'));
  assert.ok(main.includes('bindToolbar();'));
  assert.match(main, /window\.addEventListener\('scroll'/);
  assert.match(main, /classList\.toggle\('is-compact'/);
});
