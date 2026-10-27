// 回归测试：新标签页左右面板的停靠/抽屉断点
import test from 'node:test';
import assert from 'node:assert/strict';
import { isOverlayLayout, PANEL_NARROW_MAX, PANEL_DOCK_MAX } from '../newtab/js/layout.js';
import { DEFAULT_STATE } from '../newtab/js/store.js';

test('宽屏双面板保持停靠，网格按容器宽度换列', () => {
  assert.equal(isOverlayLayout(1920, true, true), false);
  assert.equal(isOverlayLayout(1440, true, true), false);
  assert.equal(isOverlayLayout(PANEL_DOCK_MAX, true, true), false);
});

test('1280 以下双面板改为抽屉，避免内容区被压扁', () => {
  assert.equal(isOverlayLayout(PANEL_DOCK_MAX - 1, true, true), true);
  assert.equal(isOverlayLayout(1100, true, true), true);
});

test('中等宽度只留一个面板时仍可停靠', () => {
  assert.equal(isOverlayLayout(1100, true, false), false);
  assert.equal(isOverlayLayout(1100, false, true), false);
  assert.equal(isOverlayLayout(PANEL_NARROW_MAX, true, false), false);
});

test('1024 以下即使只有一个面板也改为抽屉', () => {
  assert.equal(isOverlayLayout(PANEL_NARROW_MAX - 1, true, false), true);
  assert.equal(isOverlayLayout(900, false, true), true);
  assert.equal(isOverlayLayout(800, false, false), true);
});

test('异常宽度不误判为抽屉', () => {
  assert.equal(isOverlayLayout(NaN, true, true), false);
  assert.equal(isOverlayLayout(undefined, true, true), false);
});

test('默认设置保留左右面板偏好', () => {
  assert.equal(DEFAULT_STATE.settings.showSysPanel, true);
  assert.equal(DEFAULT_STATE.settings.showAiPanel, true);
});
