// 回归测试：GitHub 星级榜的格式化、查询参数与扩展接线
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import githubRanking, {
  GITHUB_PERIODS,
  buildSearchUrl,
  formatStars,
  parseCount,
} from '../newtab/js/widgets/githubRanking.js';
import { DEFAULT_STATE } from '../newtab/js/store.js';

const root = path.resolve(import.meta.dirname, '..');

test('GitHub 星级榜默认尺寸 M，包含日/周/月/年四个周期', () => {
  const item = DEFAULT_STATE.widgets.find(w => w.key === 'githubRanking');
  assert.ok(item);
  assert.equal(item.size, 'm');
  assert.equal(item.data.period, 'day');
  assert.equal(githubRanking.defaultData.period, 'day');
  assert.equal(githubRanking.defaultData.showLimit, 10);
  assert.deepEqual(GITHUB_PERIODS.map(p => p.value), ['day', 'week', 'month', 'year']);
  assert.match(githubRanking.description, /日\/周\/月/);
});

test('Star 数字格式化与热榜数字解析', () => {
  assert.equal(formatStars(999), '999');
  assert.equal(formatStars(19_735), '19.7k');
  assert.equal(formatStars(435_239), '435k');
  assert.equal(formatStars(1_200_000), '1.2m');
  assert.equal(parseCount('2,679 stars today'), 2679);
  assert.equal(parseCount('1.2k stars'), 1200);
  assert.equal(parseCount('暂无'), 0);
});

test('Search API 查询按周期生成正确的 created 日期', () => {
  const now = Date.UTC(2026, 10, 6);
  const week = new URL(buildSearchUrl('week', now));
  assert.equal(week.searchParams.get('q'), 'created:>=2026-10-30 stars:>=20 fork:false archived:false');
  assert.equal(week.searchParams.get('sort'), 'stars');
  assert.equal(week.searchParams.get('order'), 'desc');
  const year = new URL(buildSearchUrl('year', now));
  assert.equal(year.searchParams.get('q'), 'created:>=2025-11-06 stars:>=20 fork:false archived:false');
});

test('GitHub 榜单注册、缓存与网络来源已接线', () => {
  const registry = fs.readFileSync(path.join(root, 'newtab/js/widgets/registry.js'), 'utf8');
  const widget = fs.readFileSync(path.join(root, 'newtab/js/widgets/githubRanking.js'), 'utf8');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'newtab/manifest.json'), 'utf8'));
  assert.match(registry, /githubRanking/);
  assert.match(widget, /https:\/\/github\.com\/trending\?since=/);
  assert.match(widget, /https:\/\/api\.github\.com\/search\/repositories/);
  assert.match(widget, /github_ranking_cache_v1/);
  assert.match(widget, /DOMParser/);
  assert.ok(manifest.host_permissions.includes('https://github.com/*'));
  assert.ok(manifest.host_permissions.includes('https://api.github.com/*'));
  assert.equal(manifest.version, '1.6.0');
});
