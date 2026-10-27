// layout.js — 纯布局判定：左右面板何时停靠、何时改为抽屉
// 抽成纯函数便于单测，也避免 main.js 里散落魔法断点。

export const PANEL_NARROW_MAX = 1024;
export const PANEL_DOCK_MAX = 1280;

/**
 * @param {number} width 视口宽度（px）
 * @param {boolean} showSys 用户是否保留系统面板
 * @param {boolean} showAi 用户是否保留 AI 面板
 * @returns {boolean} true = 抽屉态（网格整宽，面板浮层）；false = 停靠态
 */
export function isOverlayLayout(width, showSys, showAi) {
  if (!Number.isFinite(width)) return false;
  // 窄屏无论开几个都改为抽屉，避免网格被压到无法使用
  if (width < PANEL_NARROW_MAX) return true;
  // 中等宽度下两个面板同时停靠会把内容区压到 500px 左右；只留一个时仍可停靠
  return width < PANEL_DOCK_MAX && !!showSys && !!showAi;
}
