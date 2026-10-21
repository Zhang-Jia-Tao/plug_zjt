// popover.js — 挂在 document.body 上的固定定位弹层
// 为什么放 body：widget 卡片有 overflow:hidden（圆角裁剪），卡片内部的下拉/弹层
// 会被边界割裂；挂到 body 用 fixed 定位不受裁剪，关闭时随 cleanup 移除。

// 把弹层定位到锚点正下方（自动贴边防溢出屏幕；reserveH 预留面板内容高度）
export function placePopover(pop, anchor, { width = 240, offsetY = 8, reserveH = 140 } = {}) {
  const r = anchor.getBoundingClientRect();
  const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 12));
  const top = Math.min(r.bottom + offsetY, window.innerHeight - reserveH);
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
  return pop;
}
