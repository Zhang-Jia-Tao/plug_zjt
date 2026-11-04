// 回归测试：常用网站图标的取图优先级与非法 URL 兜底
import test from 'node:test';
import assert from 'node:assert/strict';
import { faviconImgHtml } from '../newtab/js/favicon.js';

test('favicon 先给 Chrome 缓存 URL，同时带上站点自身 favicon 供异步替换', () => {
  const html = faviconImgHtml('https://github.com/explore?tab=repositories');
  assert.match(html, /src="chrome:\/\/favicon2\/\?size=64&amp;scale=1x&amp;page_url=/);
  assert.match(html, /data-site-fav="https:\/\/github\.com\/favicon\.ico"/);
  assert.match(html, /data-fav-for="https:\/\/github\.com\/explore\?tab=repositories"/);
});

test('favicon 保留 https，不把站点图标降级到 http', () => {
  const html = faviconImgHtml('https://www.zhihu.com/question/1');
  assert.match(html, /data-site-fav="https:\/\/www\.zhihu\.com\/favicon\.ico"/);
  assert.doesNotMatch(html, /data-site-fav="http:/);
});

test('非 http/https URL 不生成图片，交给字母磁贴兜底', () => {
  assert.equal(faviconImgHtml('chrome://extensions'), '');
  assert.equal(faviconImgHtml('file:///C:/notes/a.md'), '');
  assert.equal(faviconImgHtml('not a url'), '');
});
