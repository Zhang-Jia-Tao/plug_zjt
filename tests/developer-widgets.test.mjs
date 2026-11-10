// 回归测试：5 个开发者工作组的注册、默认尺寸与关键纯函数
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_STATE } from '../newtab/js/store.js';
import aiCost, {
  formatCost,
  formatTokens,
  priceFor,
  summarizeSessions,
} from '../newtab/js/widgets/aiCost.js';
import promptVault, { DEFAULT_ITEMS } from '../newtab/js/widgets/promptVault.js';
import devServices from '../newtab/js/widgets/devServices.js';
import githubWorkbench, {
  buildSearchUrl,
  failedChecks,
  friendlyGhError,
  normalizeSearchItem,
  parseRepo,
} from '../newtab/js/widgets/githubWorkbench.js';
import dependencyRadar, {
  cleanSpecVersion,
  normalizeAdvisories,
  parsePackageDeps,
  parseRepoInput,
  severityRank,
} from '../newtab/js/widgets/dependencyRadar.js';

const root = path.resolve(import.meta.dirname, '..');
const NEW_KEYS = ['githubWorkbench', 'aiCost', 'dependencyRadar', 'promptVault', 'devServices'];

test('5 个开发者工作组已注册且默认尺寸为 M', () => {
  for (const key of NEW_KEYS) {
    const item = DEFAULT_STATE.widgets.find(w => w.key === key);
    assert.ok(item, `缺少 ${key}`);
    assert.equal(item.size, 'm');
  }
  assert.equal(DEFAULT_STATE.widgets.at(-1).key, 'focusTimer');
  assert.equal(DEFAULT_STATE.widgets.length, 13);
});

test('AI 成本：人民币定价、会话汇总和成本格式', () => {
  assert.equal(priceFor('claude-sonnet-4').input, 3);
  assert.equal(priceFor('ollama/qwen2.5').input, 0);
  const summary = summarizeSessions([{
    app: 'claude-code',
    model: 'claude-sonnet-4',
    sumIn: 1_000_000,
    sumCacheRead: 1_000_000,
    sumOut: 1_000_000,
    turns: 3,
  }]);
  assert.equal(summary.tokens, 3_000_000);
  assert.equal(summary.turns, 3);
  assert.equal(summary.cost, 131.76);
  assert.equal(summary.models[0].name, 'claude-sonnet-4');
  assert.equal(formatCost(0.004), '¥0.004');
  assert.equal(formatCost(131.76), '¥131.76');
  assert.equal(formatTokens(1_200_000), '1.2m');
  assert.equal(aiCost.config[0].key, 'budget');
  assert.equal(aiCost.defaultData.budget, '100');
});

test('Prompt 速取：内置模板和默认数据', () => {
  assert.ok(DEFAULT_ITEMS.length >= 5);
  assert.ok(DEFAULT_ITEMS.every(item => item.title && item.body && item.tag));
  assert.equal(promptVault.defaultData.items.length, DEFAULT_ITEMS.length);
  assert.equal(promptVault.key, 'promptVault');
});

test('开发服务台默认不添加任何探测目标，避免首次打开满屏红点', () => {
  assert.deepEqual(devServices.defaultData.services, []);
  assert.equal(devServices.key, 'devServices');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'newtab/manifest.json'), 'utf8'));
  assert.ok(manifest.host_permissions.includes('http://localhost/*'));
  assert.ok(manifest.host_permissions.includes('http://127.0.0.1/*'));
});

test('GitHub 工作台：仓库解析、搜索地址、条目归一化与错误文案', () => {
  const repo = parseRepo('https://github.com/vuejs/core.git');
  assert.deepEqual(
    { owner: repo.owner, repo: repo.repo },
    { owner: 'vuejs', repo: 'core' },
  );
  const review = new URL(buildSearchUrl('review'));
  assert.match(review.searchParams.get('q'), /review-requested:@me/);
  assert.match(review.searchParams.get('q'), /is:pr/);
  const mine = new URL(buildSearchUrl('mine'));
  assert.match(mine.searchParams.get('q'), /author:@me/);
  assert.equal(buildSearchUrl('ci'), null);

  const item = normalizeSearchItem({
    number: 12,
    title: 'fix: something',
    html_url: 'https://github.com/a/b/pull/12',
    repository_url: 'https://api.github.com/repos/a/b',
    user: { login: 'octocat' },
    updated_at: '2026-11-06T10:00:00Z',
  }, Date.UTC(2026, 10, 6, 12));
  assert.equal(item.owner, 'a');
  assert.equal(item.repo, 'b');
  assert.equal(item.repoLabel, 'a/b');
  assert.equal(item.number, 12);
  assert.match(item.updatedLabel, /2 小时前/);

  const failed = failedChecks([{
    number: 2,
    title: 'CI broken',
    url: 'https://github.com/a/b/pull/2',
    repository: { nameWithOwner: 'a/b' },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: 'FAILURE' } } }] },
  }]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].state, 'FAILURE');
  assert.match(friendlyGhError(401), /Token/);
  assert.match(friendlyGhError(403), /403/);
  assert.match(friendlyGhError(new TypeError('Failed to fetch')), /网络/);
  assert.equal(githubWorkbench.key, 'githubWorkbench');
});

test('依赖雷达：仓库解析、直接依赖、版本清洗和漏洞排序', () => {
  assert.equal(parseRepoInput('https://github.com/vuejs/core/tree/main'), 'vuejs/core');
  assert.equal(parseRepoInput('git@github.com:facebook/react.git'), 'facebook/react');
  assert.equal(parseRepoInput('not-a-repo'), null);
  assert.equal(cleanSpecVersion('^18.2.0'), '18.2.0');
  assert.equal(cleanSpecVersion('workspace:*'), '');

  const deps = parsePackageDeps({
    dependencies: { vue: '^3.4.0', broken: 'workspace:*' },
    devDependencies: { vite: '^5.0.0' },
  }, {
    packages: {
      'node_modules/vue': { version: '3.4.21' },
      'node_modules/vite': { version: '5.2.0' },
    },
  });
  assert.deepEqual(deps.map(d => [d.name, d.version]), [
    ['vue', '3.4.21'],
    ['vite', '5.2.0'],
  ]);
  assert.equal(deps.source, 'package-lock');

  assert.equal(severityRank('critical'), 0);
  assert.ok(severityRank('high') < severityRank('low'));
  const vulns = normalizeAdvisories({
    lodash: [
      { id: 1, title: 'low issue', severity: 'low', vulnerable_versions: '<4.17.21' },
      { id: 2, title: 'critical issue', severity: 'critical', url: 'https://github.com/advisories/GHSA-1' },
    ],
  }, [{ name: 'lodash', version: '4.17.20' }]);
  assert.equal(vulns[0].severity, 'critical');
  assert.equal(vulns[0].package, 'lodash');
  assert.equal(vulns[0].version, '4.17.20');
  assert.equal(dependencyRadar.defaultData.repo, '');
});

test('样式和注册表包含 5 个新组件', () => {
  const css = fs.readFileSync(path.join(root, 'newtab/css/widgets.css'), 'utf8');
  const registry = fs.readFileSync(path.join(root, 'newtab/js/widgets/registry.js'), 'utf8');
  for (const sel of ['.mini-widget', '.gw-widget', '.ac-widget', '.dr-widget', '.pv-widget', '.ds-widget']) {
    assert.ok(css.includes(sel), `缺少样式 ${sel}`);
  }
  for (const key of NEW_KEYS) assert.match(registry, new RegExp(key));
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'newtab/manifest.json'), 'utf8'));
  assert.equal(manifest.version, '1.7.0');
  assert.ok(manifest.host_permissions.includes('https://raw.githubusercontent.com/*'));
  assert.ok(manifest.host_permissions.includes('https://registry.npmjs.org/*'));
});

test('新标签页打开时不因 GitHub 工作台 Token 输入框抢焦点', () => {
  const workbench = fs.readFileSync(path.join(root, 'newtab/js/widgets/githubWorkbench.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'newtab/js/main.js'), 'utf8');
  assert.match(workbench, /openSetup\(\{ firstRun: true, focus: false \}\)/);
  assert.match(workbench, /if \(focus && inputEl\) inputEl\.focus\(\)/);
  assert.match(main, /function focusSearchOnOpen\(/);
  assert.match(main, /requestAnimationFrame\(\(\) => requestAnimationFrame\(focusSearchOnOpen\)\)/);
  assert.match(main, /querySelector\('\.search-input'\)/);
});

test('设置页有分类导航、组件尺寸控件和人民币预算文案', () => {
  const html = fs.readFileSync(path.join(root, 'newtab/index.html'), 'utf8');
  const settingsCss = fs.readFileSync(path.join(root, 'newtab/css/settings.css'), 'utf8');
  const widgetCss = fs.readFileSync(path.join(root, 'newtab/css/widgets.css'), 'utf8');
  assert.match(html, /data-settings-tab="appearance"/);
  assert.match(html, /data-settings-pane="widgets"/);
  assert.match(html, /id="widget-config-count"/);
  assert.match(settingsCss, /\.settings-nav\b/);
  assert.match(settingsCss, /\.wci-size-btn\b/);
  assert.match(settingsCss, /\.settings-row-switch\b/);
  assert.match(widgetCss, /\.mini-btn\s*\{[\s\S]*?white-space: nowrap/);
});
