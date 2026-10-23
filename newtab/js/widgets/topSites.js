// widgets/topSites.js — 常用网站小组件
// chrome.topSites 读取浏览器「最常访问」+ 用户自定义网址（data.customSites）合并显示。
// 图标：优先请求站点真实 favicon（origin/favicon.ico），失败回退品牌色首字母磁贴。
// 添加表单弹层挂 document.body（widget 卡片 overflow:hidden 会裁剪卡内弹层）。
// 私有配置：showLimit、newTab、customSites

import { placePopover } from './popover.js';
import { faviconImgHtml, wireFavicons } from '../favicon.js';

// 品牌色兜底：常见站点给固定颜色，其余按域名哈希取色
//（书签栏 bookmarksbar.js 也复用这两个函数，保持全站配色一致）
const BRAND_COLORS = {
  'github.com': '#181717', 'gitlab.com': '#fc6d26', 'stackoverflow.com': '#f48024',
  'bilibili.com': '#fb7299', 'zhihu.com': '#0084ff', 'csdn.net': '#fc5531',
  'juejin.cn': '#1e80ff', 'segmentfault.com': '#00965e', 'cnblogs.com': '#20a0ff',
  'baidu.com': '#2932e1', 'google.com': '#4285f4', 'bing.com': '#008373',
  'taobao.com': '#ff6a00', 'jd.com': '#e3101e', 'qq.com': '#12b7f5',
  'weibo.com': '#e6162d', 'douyin.com': '#111111', 'aliyun.com': '#ff6a00',
  'cloud.tencent.com': '#006eff', 'huaweicloud.com': '#c7000b', 'vuejs.org': '#42b883',
  'react.dev': '#087ea4', 'spring.io': '#6db33f', 'maven.apache.org': '#c71a36',
  'npmjs.com': '#cb3837', 'mvnrepository.com': '#3d85c6', 'mdn.mozilla.org': '#000000',
  'developer.mozilla.org': '#000000', 'leetcode.cn': '#ffa116', 'chat.openai.com': '#10a37f',
};
const HASH_PALETTE = ['#4285f4', '#ea4335', '#fbbc05', '#34a853', '#8e44ad',
  '#16a085', '#c0392b', '#d35400', '#2980b9', '#7f8c8d'];

/** 域名 → 品牌色/哈希色 */
export function colorFor(hostname) {
  for (const [domain, color] of Object.entries(BRAND_COLORS)) {
    if (hostname === domain || hostname.endsWith('.' + domain)) return color;
  }
  let hash = 0;
  for (const ch of hostname) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return HASH_PALETTE[hash % HASH_PALETTE.length];
}

/** 域名 → 磁贴首字母 */
export function letterFor(hostname) {
  return (hostname.replace(/^www\./, '')[0] || '?').toUpperCase();
}

// 归一化用户输入为 URL（无协议补 https://），无法解析返回 null
function normalizeUrl(input) {
  const raw = input.trim();
  if (!raw) return null;
  const withProto = /^(https?:\/\/)/.test(raw) ? raw : `https://${raw}`;
  try {
    const u = new URL(withProto);
    if (!/^[\w-]+(\.[\w-]+)+/.test(u.hostname)) return null;
    return u.href;
  } catch {
    return null;
  }
}

export default {
  key: 'topSites',
  label: '常用网站',
  description: '仿谷歌首页的快捷方式磁贴，自动读取最常访问，可自定义添加网址',
  defaultData: { showLimit: 10, newTab: false, customSites: [] },
  config: [
    { key: 'showLimit', label: '显示个数', type: 'select', default: 10, options: [
      { value: 5, label: '5 个' },
      { value: 10, label: '10 个' },
      { value: 20, label: '20 个' },
    ] },
    { key: 'newTab', label: '新标签打开', type: 'bool', default: false },
  ],

  init(container, data, api) {
    if (!Array.isArray(data.customSites)) data.customSites = [];
    const el = document.createElement('div');
    el.className = 'top-sites';
    container.appendChild(el);

    // 添加按钮（磁贴网格末尾的 + 卡）
    const addBtn = document.createElement('button');
    addBtn.className = 'site-tile site-add';
    addBtn.title = '添加常用网站';
    addBtn.innerHTML = '<span class="site-icon site-add-icon">+</span><span class="site-name">添加</span>';

    // 添加表单弹层（挂 body，避免卡片 overflow:hidden 裁剪）
    let form = null;
    function closeForm() {
      if (form) { form.remove(); form = null; }
    }
    function openForm(anchor) {
      closeForm();
      form = document.createElement('div');
      form.className = 'tc-event-panel site-add-form';
      form.innerHTML = `
        <div class="tc-panel-head">
          <span>添加常用网站</span>
          <button class="tc-panel-close" title="关闭">✕</button>
        </div>
        <div class="tc-panel-add">
          <input type="text" class="tc-add-input" placeholder="网址，如 github.com" maxlength="200" />
          <p class="tc-form-tip"></p>
        </div>
      `;
      document.body.appendChild(form);
      placePopover(form, anchor, { width: 260 });
      const input = form.querySelector('.tc-add-input');
      input.focus();
      form.querySelector('.tc-panel-close').addEventListener('click', closeForm);
      input.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const url = normalizeUrl(input.value);
        const tip = form.querySelector('.tc-form-tip');
        if (!url) {
          tip.textContent = '网址格式不正确，示例：github.com';
          return;
        }
        // 与已有自定义项 + topSites 去重
        const exists = (data.customSites || []).some(c => c.url === url)
          || lastSites.some(s => s.url === url);
        if (exists) {
          tip.textContent = '该网址已在列表中';
          return;
        }
        data.customSites = [...(data.customSites || []), { id: crypto.randomUUID(), url }];
        if (api?.patchWidget) api.patchWidget({ customSites: data.customSites });
        closeForm();
        render(lastSites);
      });
    }

    const onDocClick = (e) => {
      if (form && !form.contains(e.target) && !addBtn.contains(e.target)) closeForm();
    };
    document.addEventListener('click', onDocClick);
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openForm(addBtn);
    });

    let lastSites = []; // 最近一次 topSites 结果（添加时去重用）

    function render(sites) {
      lastSites = sites || [];
      const limit = +data.showLimit || 10;
      const custom = data.customSites || [];
      // 自定义项排在最前，topSites 补足；同域名只留一个
      const seenHost = new Set();
      const merged = [];
      for (const c of custom) {
        const host = hostnameOf(c.url);
        if (seenHost.has(host)) continue;
        seenHost.add(host);
        merged.push({ url: c.url, title: host, custom: true, id: c.id });
      }
      for (const s of lastSites) {
        if (merged.length >= limit) break;
        const host = hostnameOf(s.url);
        if (seenHost.has(host)) continue;
        seenHost.add(host);
        merged.push({ url: s.url, title: s.title || host, custom: false });
      }
      const list = merged.slice(0, limit);
      el.innerHTML = list.map(s => {
        const host = hostnameOf(s.url);
        const color = colorFor(host);
        const letter = (host.replace(/^www\./, '')[0] || '?').toUpperCase();
        const name = (s.title || host).replace(/^www\./, '');
        return `
          <a class="site-tile" href="${escapeAttr(s.url)}" ${data.newTab ? 'target="_blank" rel="noopener"' : ''} title="${escapeAttr(name)}">
            <span class="site-icon fav-wrap" style="--site-color:${color}">
              <span class="fav-letter">${escapeHtml(letter)}</span>
              ${faviconImgHtml(s.url, { eager: true })}
            </span>
            <span class="site-name">${escapeHtml(name.slice(0, 12))}</span>
            ${s.custom ? `<button class="site-del" data-id="${s.id}" title="移除自定义网址">✕</button>` : ''}
          </a>
        `;
      }).join('');
      // 磁贴 favicon 是可见的（无隐藏容器），用 eager 直读
      wireFavicons(el);
      if (merged.length < limit || true) el.appendChild(addBtn);
    }

    // 移除自定义网址（事件委托）
    el.addEventListener('click', (e) => {
      const del = e.target.closest('.site-del');
      if (!del) return;
      e.preventDefault();
      e.stopPropagation();
      data.customSites = (data.customSites || []).filter(c => c.id !== del.dataset.id);
      if (api?.patchWidget) api.patchWidget({ customSites: data.customSites });
      render(lastSites);
    });

    try {
      chrome.topSites.get((sites) => {
        render(chrome.runtime.lastError ? [] : sites);
      });
    } catch {
      render([]);
    }

    return () => {
      document.removeEventListener('click', onDocClick);
      closeForm();
    };
  },
};

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return String(url); }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
