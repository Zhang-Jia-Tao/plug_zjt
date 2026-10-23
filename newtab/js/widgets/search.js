// widgets/search.js — 搜索框小组件
// 仿谷歌首页的中央搜索框，支持框内一键切换搜索引擎（Google/Bing/百度）。
// 右侧 AI 图标：点开搜索框下方的 AI 查询入口（豆包/DeepSeek/ChatGPT/Gemini），
// 有输入内容且入口支持带参时直接发起提问，否则打开对应首页。
// 引擎菜单挂 document.body（widget 卡片 overflow:hidden 会裁剪卡内浮层）；
// AI 面板则采用文档流内渲染（卡片高度自适应增长，天然不被裁剪）。
// 私有配置：engine（google/bing/baidu）、newTab（新标签打开）

import { placePopover } from './popover.js';
import { faviconImgHtml, wireFavicons } from '../favicon.js';
import { colorFor, letterFor } from './topSites.js';

const ENGINES = [
  { value: 'google', label: 'Google', url: 'https://www.google.com/search?q=' },
  { value: 'bing',   label: 'Bing',   url: 'https://www.bing.com/search?q=' },
  { value: 'baidu',  label: '百度',   url: 'https://www.baidu.com/s?wd=' },
];

// AI 查询入口：q 模板存在时支持把搜索词带过去；豆包/DeepSeek/Gemini 网页版
// 不支持 URL 直带提问，点击直接打开对话页。
// 图标：优先站点真实 favicon，失败回退品牌色首字母（与书签栏/磁贴同套路）。
const AI_PROVIDERS = [
  { value: 'doubao',   label: '豆包',     icon: '🤖', url: 'https://www.doubao.com/chat/', favUrl: 'https://www.doubao.com/' },
  { value: 'deepseek', label: 'DeepSeek', icon: '🐋', url: 'https://chat.deepseek.com/' },
  { value: 'chatgpt',  label: 'ChatGPT',  icon: '✳',  url: 'https://chatgpt.com/', q: 'https://chatgpt.com/?q=' },
  { value: 'gemini',   label: 'Gemini',   icon: '✦',  url: 'https://gemini.google.com/app' },
];

export default {
  key: 'search',
  label: '搜索框',
  description: '仿谷歌首页的中央搜索框，支持切换搜索引擎，带 AI 查询入口',
  defaultData: { engine: 'google', newTab: false },
  config: [
    { key: 'engine', label: '搜索引擎', type: 'select', default: 'google', options: ENGINES },
    { key: 'newTab', label: '新标签打开结果', type: 'bool', default: false },
  ],

  init(container, data, api) {
    const el = document.createElement('form');
    el.className = 'search-widget';
    el.innerHTML = `
      <div class="search-brand">
        <img class="search-brand-img" src="../img/brand.png" alt="可定制新标签页" />
      </div>
      <div class="search-bar">
        <span class="search-engine-btn" title="切换搜索引擎">
          <span class="search-engine-badge fav-wrap" style="--tab-color:${colorFor('google.com')}">
            <span class="fav-letter">${letterFor('google.com')}</span>
            ${faviconImgHtml(ENGINES[0].url, { eager: true })}
          </span>
        </span>
        <input type="text" class="search-input" placeholder="搜索或输入网址…" autocomplete="off" />
        <button type="button" class="search-ai-btn" title="AI 查询入口">
          <span class="search-ai-icon">✦</span>
        </button>
      </div>
      <div class="search-ai-panel hidden">
        <div class="ai-panel-list">
          ${AI_PROVIDERS.map(p => `
            <button type="button" class="ai-entry" data-ai="${p.value}">
              <span class="ai-entry-icon fav-wrap" style="--tab-color:${colorFor(hostOfAi(p))}">
                <span class="fav-letter">${letterFor(hostOfAi(p))}</span>
                ${faviconImgHtml(hostOfAi(p), { eager: true })}
              </span>
              <span class="ai-entry-name">${p.label}</span>
              ${p.q ? '<span class="ai-entry-hint">支持直接提问</span>' : ''}
            </button>
          `).join('')}
        </div>
      </div>
    `;
    container.appendChild(el);
    wireFavicons(el);

    // 引擎菜单挂 body，fixed 定位（避免被卡片 overflow:hidden 裁剪）
    const menu = document.createElement('div');
    menu.className = 'search-engine-menu hidden';
    menu.innerHTML = ENGINES.map(e => {
      const host = new URL(e.url).hostname;
      return `
      <button type="button" class="search-engine-option" data-engine="${e.value}">
        <span class="se-badge fav-wrap" style="--tab-color:${colorFor(host)}">
          <span class="fav-letter">${letterFor(host)}</span>
          ${faviconImgHtml(e.url, { eager: true })}
        </span>${e.label}
      </button>
      `;
    }).join('');
    document.body.appendChild(menu);

    const input = el.querySelector('.search-input');
    const badge = el.querySelector('.search-engine-badge');
    const engineBtn = el.querySelector('.search-engine-btn');
    const aiBtn = el.querySelector('.search-ai-btn');
    const aiPanel = el.querySelector('.search-ai-panel');

    function applyEngineBadge() {
      const def = ENGINES.find(e => e.value === data.engine) || ENGINES[0];
      const host = new URL(def.url).hostname;
      // 引擎徽标：真实 favicon 优先，失败回退首字母磁贴
      badge.style.setProperty('--tab-color', colorFor(host));
      badge.innerHTML = `
        <span class="fav-letter">${letterFor(host)}</span>
        ${faviconImgHtml(def.url, { eager: true })}
      `;
      wireFavicons(badge);
      engineBtn.title = `当前：${def.label}，点击切换`;
    }
    applyEngineBadge();

    const onDocClick = (e) => {
      if (!menu.contains(e.target) && !engineBtn.contains(e.target)) {
        menu.classList.add('hidden');
      }
      // 点 widget 外关闭 AI 面板（面板本身在 widget 内，点面板不算外部）
      if (!aiPanel.classList.contains('hidden') && !el.contains(e.target)) {
        aiPanel.classList.add('hidden');
        aiBtn.classList.remove('active');
      }
    };

    engineBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = menu.classList.toggle('hidden');
      if (!open) placePopover(menu, engineBtn, { width: 160 });
    });
    document.addEventListener('click', onDocClick);
    wireFavicons(menu);
    menu.addEventListener('click', async (e) => {
      const opt = e.target.closest('.search-engine-option');
      if (!opt) return;
      e.preventDefault();
      e.stopPropagation();
      data.engine = opt.dataset.engine;
      applyEngineBadge();
      menu.classList.add('hidden');
      input.focus();
      if (api?.patchWidget) api.patchWidget({ engine: data.engine });
    });

    // AI 面板开合（点 AI 图标切换）
    aiBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = aiPanel.classList.toggle('hidden');
      aiBtn.classList.toggle('active', !open);
      if (!open) input.focus();
    });

    // 点 AI 入口：AI 对话页一律新标签打开（不离开新标签页）
    aiPanel.addEventListener('click', (e) => {
      const entry = e.target.closest('.ai-entry');
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      const p = AI_PROVIDERS.find(x => x.value === entry.dataset.ai);
      if (!p) return;
      const q = input.value.trim();
      const url = (q && p.q) ? p.q + encodeURIComponent(q) : p.url;
      window.open(url, '_blank', 'noopener');
    });

    el.addEventListener('submit', (e) => {
      e.preventDefault();
      const q = input.value.trim();
      if (!q) return;
      // 纯 URL 输入直接跳转（带点或 http 前缀视为网址）
      const isUrl = /^(https?:\/\/)/.test(q) || (/^[\w-]+(\.[\w-]+)+/.test(q) && !q.includes(' '));
      const url = isUrl
        ? (/^(https?:\/\/)/.test(q) ? q : `https://${q}`)
        : (ENGINES.find(x => x.value === data.engine) || ENGINES[0]).url + encodeURIComponent(q);
      if (data.newTab) window.open(url, '_blank');
      else window.location.href = url;
    });

    return () => {
      // 清理：移除 body 挂载的菜单与全局监听
      document.removeEventListener('click', onDocClick);
      menu.remove();
    };
  },
};

// AI 入口 host（豆包对话页域名取主页域名以保持品牌色一致）
function hostOfAi(p) {
  try { return new URL(p.favUrl || p.url).hostname; } catch { return p.url; }
}
