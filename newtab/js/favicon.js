// favicon.js — 站点真实 favicon 公共加载逻辑
// 书签栏 / 常用网站磁贴 / 搜索引擎徽标共用。
// 策略：底层字母磁贴 + 上层 favicon 图（.fav-img）。
// 取图走 chrome://favicon2（manifest 需 "favicon" 权限）——直接读 Chrome 自带的
// favicon 缓存：零网络请求、瞬时显示、失败自动回退字母磁贴。
// 旧方案（请求 origin/favicon.ico）已弃用：慢站点/404 会让图标秒级延迟才出现。

/**
 * 生成 favicon <img> HTML；非 http/https 或非法 URL 返回空串
 * @param {string} url 站点完整 URL
 * @param {{ eager?: boolean }} [opts] eager=true 立即加载（默认 lazy；隐藏容器里的 lazy 图不会触发请求）
 * @returns {string} img 标签 HTML 或空串
 */
export function faviconImgHtml(url, { eager = false } = {}) {
  let page = '';
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') page = u.href;
  } catch { /* 非法 URL 不请求 */ }
  if (!page) return '';
  // Chrome 内置 favicon 缓存：有缓存返回真实图标，无缓存返回默认地球图标，异常走 error
  const src = `chrome://favicon2/?size=32&scale=1x&page_url=${encodeURIComponent(page)}`;
  return `<img class="fav-img" src="${escapeAttr(src)}" data-fav-for="${escapeAttr(page)}" alt="" ${eager ? '' : 'loading="lazy"'} />`;
}

/**
 * 给 scope 内所有 .fav-img 挂成功/失败处理（父元素需带 .fav-wrap）
 * @param {ParentNode} scope 查找范围
 */
export function wireFavicons(scope) {
  for (const img of scope.querySelectorAll('.fav-img')) {
    // 双保险：没记录原始站点 URL（历史渲染残留/异常数据）直接移除
    if (!img.dataset.favFor) { img.remove(); continue; }
    const wrap = img.parentElement;
    if (img.complete) {
      // 缓存命中：同步判定（complete 且 naturalWidth>0 = 成功）
      if (img.naturalWidth > 0) wrap.classList.add('loaded');
      else img.remove();
    } else {
      img.addEventListener('load', () => wrap.classList.add('loaded'), { once: true });
      img.addEventListener('error', () => img.remove(), { once: true });
    }
  }
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
