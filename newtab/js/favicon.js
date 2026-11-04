// favicon.js — 站点真实 favicon 公共加载逻辑
// 书签栏 / 常用网站磁贴 / 搜索引擎徽标共用。
// 策略：底层字母磁贴 + 上层 favicon 图（.fav-img）。
//
// 取图优先级：
//   1. 站点自身 origin/favicon.ico（用户可收藏任意网站，站点自带的图标最新、最准）；
//   2. chrome://favicon2 缓存（要求 manifest 有 "favicon" 权限）——网络慢/404 时先顶住，
//      并且站点自身图标加载成功后再替换成站点图标；
//   3. 都没有就保留底层字母磁贴。
//
// 站点自身图标用临时 Image 探测，不阻塞首屏；已缓存的图标先显示，避免慢站点白屏。

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

  const cacheSrc = chromeCacheSrc(page);
  const siteSrc = siteFaviconSrc(page);
  return `<img class="fav-img" src="${escapeAttr(cacheSrc)}" data-fav-for="${escapeAttr(page)}" data-site-fav="${escapeAttr(siteSrc)}" alt="" ${eager ? '' : 'loading="lazy"'} />`;
}

function chromeCacheSrc(page) {
  return `chrome://favicon2/?size=64&scale=1x&page_url=${encodeURIComponent(page)}`;
}

// 站点自身图标：origin/favicon.ico。保留页面协议，https 站点不会降级到 http。
function siteFaviconSrc(page) {
  try {
    const u = new URL(page);
    return new URL('/favicon.ico', u.origin).href;
  } catch {
    return '';
  }
}

/**
 * 给 scope 内所有 .fav-img 挂成功/失败处理（父元素需带 .fav-wrap）
 * @param {ParentNode} scope 查找范围
 */
export function wireFavicons(scope) {
  for (const img of scope.querySelectorAll('.fav-img')) {
    // 双保险：没记录原始站点 URL（历史渲染残留/异常数据）直接移除
    if (!img.dataset.favFor) { img.remove(); continue; }
    if (img.dataset.favWired === '1') continue;
    img.dataset.favWired = '1';

    const wrap = img.parentElement;
    const siteSrc = img.dataset.siteFav || '';
    let siteProbeStarted = false;

    const markLoaded = () => {
      wrap.classList.add('loaded');
      img.style.display = '';
    };
    const markHidden = () => {
      img.style.display = 'none';
    };

    // 站点自身图标探测：成功就替换缓存图；失败保持缓存/字母兜底。
    const probeSiteIcon = () => {
      if (!siteSrc || siteProbeStarted) return;
      siteProbeStarted = true;
      const probe = new Image();
      probe.decoding = 'async';
      probe.onload = () => {
        if (probe.naturalWidth <= 0 || probe.naturalHeight <= 0) return;
        img.src = siteSrc;
        img.dataset.favSource = 'site';
        img.style.display = '';
        markLoaded();
      };
      probe.onerror = () => { /* 站点没有根 favicon.ico，保留缓存图标 */ };
      probe.src = siteSrc;
    };

    // 缓存图先处理；无论成功失败都并行探测站点图标，站点图标最终优先。
    const onCacheLoad = () => {
      if (img.naturalWidth > 0) markLoaded();
      else markHidden();
    };
    const onCacheError = () => {
      markHidden();
      probeSiteIcon();
    };

    if (img.complete) {
      if (img.naturalWidth > 0) markLoaded();
      else markHidden();
    } else {
      img.addEventListener('load', onCacheLoad, { once: true });
      img.addEventListener('error', onCacheError, { once: true });
    }
    probeSiteIcon();
  }
}

function escapeAttr(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
