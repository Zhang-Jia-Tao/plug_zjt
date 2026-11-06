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
// 图标：优先站点自身 favicon，其次 Chrome 缓存，失败回退品牌色首字母。
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
    // 品牌图标浮出卡片上缘（脱离搜索框组件范围）：该卡片放行 overflow 裁剪
    container.parentElement.classList.add('widget-search');
    const aiPanelId = `search-ai-panel-${crypto.randomUUID()}`;
    const el = document.createElement('form');
    el.className = 'search-widget';
    el.innerHTML = `
      <div class="search-brand">
        <img class="search-brand-img" src="../img/brand.png" alt="可定制新标签页" />
      </div>
      <!-- 搜索卡片上缘的两只小猫：左边站着伸懒腰，右边躺着打盹。
           纯内联 SVG + CSS 动画，不额外发图片请求，也不挡输入框点击。 -->
      <div class="search-cats" aria-hidden="true">
        <span class="search-cat search-cat-stand">
          <svg viewBox="0 0 56 48" width="52" height="45" role="presentation">
            <g class="cat-tail-swing">
              <path d="M36 38c8 2 14-3 12-12" fill="none" stroke="#5d3b24" stroke-width="5" stroke-linecap="round" />
              <path d="M36 38c8 2 14-3 12-12" fill="none" stroke="#e89a55" stroke-width="3" stroke-linecap="round" />
            </g>
            <path d="M28 45c-8 0-13-5-13-13V22c0-8 5-13 13-13s13 5 13 13v10c0 8-5 13-13 13z" fill="#efa45f" stroke="#5d3b24" stroke-width="2" />
            <path d="M28 31c-5 0-8 4-8 9 0 3 3 5 8 5s8-2 8-5c0-5-3-9-8-9z" fill="#fff1dc" />
            <ellipse cx="21" cy="43" rx="5" ry="3" fill="#fff1dc" stroke="#5d3b24" stroke-width="1.6" />
            <ellipse cx="35" cy="43" rx="5" ry="3" fill="#fff1dc" stroke="#5d3b24" stroke-width="1.6" />
            <g class="cat-head-tilt">
              <path d="M17 12 15 2l10 6z" fill="#efa45f" stroke="#5d3b24" stroke-width="2" stroke-linejoin="round" />
              <path d="M39 12 41 2 31 8z" fill="#efa45f" stroke="#5d3b24" stroke-width="2" stroke-linejoin="round" />
              <path d="M19 8l-2-4 4 2z" fill="#f7c6a3" />
              <path d="M37 8l2-4-4 2z" fill="#f7c6a3" />
              <circle cx="28" cy="16" r="11" fill="#efa45f" stroke="#5d3b24" stroke-width="2" />
              <path d="M23 9c1 1 2 2 2 3M28 8v4M33 9c-1 1-2 2-2 3" fill="none" stroke="#c97735" stroke-width="1.4" stroke-linecap="round" />
              <ellipse class="cat-eye" cx="24" cy="16" rx="1.7" ry="2.4" fill="#3b2418" />
              <ellipse class="cat-eye" cx="32" cy="16" rx="1.7" ry="2.4" fill="#3b2418" />
              <path d="M28 21l-2-2h4z" fill="#e9898f" />
              <path d="M28 21v2M25 20c-2 1-4 2-5 4M31 20c2 1 4 2 5 4" fill="none" stroke="#5d3b24" stroke-width="1.1" stroke-linecap="round" />
            </g>
          </svg>
        </span>
        <span class="search-cat search-cat-lie">
          <svg viewBox="0 0 84 40" width="80" height="38" role="presentation">
            <g class="cat-lie-tail">
              <path d="M17 34C8 36 4 30 8 24c3-4 7-3 8 1" fill="none" stroke="#5d3b24" stroke-width="5" stroke-linecap="round" />
              <path d="M17 34C8 36 4 30 8 24c3-4 7-3 8 1" fill="none" stroke="#e89a55" stroke-width="3" stroke-linecap="round" />
            </g>
            <path d="M14 34c-5 0-8-4-8-9 0-6 6-9 15-9h24c7 0 12 3 12 7 0 4-4 7-12 7H30c-8 0-12 1-16 4z" fill="#efa45f" stroke="#5d3b24" stroke-width="2" />
            <path d="M19 26c4-2 11-2 16-2h11c4 0 7 1 7 3s-3 3-7 3H28c-5 0-8-1-9-4z" fill="#fff1dc" />
            <ellipse cx="45" cy="33" rx="7" ry="3" fill="#fff1dc" stroke="#5d3b24" stroke-width="1.6" />
            <ellipse cx="59" cy="33" rx="7" ry="3" fill="#fff1dc" stroke="#5d3b24" stroke-width="1.6" />
            <g class="cat-head-tilt">
              <path d="M56 14 54 4l10 6z" fill="#efa45f" stroke="#5d3b24" stroke-width="2" stroke-linejoin="round" />
              <path d="M78 14 80 4l-10 6z" fill="#efa45f" stroke="#5d3b24" stroke-width="2" stroke-linejoin="round" />
              <path d="M58 10l-2-4 4 2z" fill="#f7c6a3" />
              <path d="M76 10l2-4-4 2z" fill="#f7c6a3" />
              <circle cx="67" cy="18" r="11" fill="#efa45f" stroke="#5d3b24" stroke-width="2" />
              <path d="M62 11c1 1 2 2 2 3M67 10v4M72 11c-1 1-2 2-2 3" fill="none" stroke="#c97735" stroke-width="1.4" stroke-linecap="round" />
              <ellipse class="cat-eye" cx="63" cy="18" rx="1.6" ry="2.2" fill="#3b2418" />
              <ellipse class="cat-eye" cx="71" cy="18" rx="1.6" ry="2.2" fill="#3b2418" />
              <path d="M67 23l-2-2h4z" fill="#e9898f" />
              <path d="M67 23v2M64 22c-2 1-4 2-5 4M70 22c2 1 4 2 5 4" fill="none" stroke="#5d3b24" stroke-width="1.1" stroke-linecap="round" />
            </g>
            <g class="cat-zzz">
              <text x="76" y="10">z</text>
              <text x="80" y="4">z</text>
            </g>
          </svg>
        </span>
      </div>
      <div class="search-bar">
        <button type="button" class="search-engine-btn" title="切换搜索引擎" aria-label="切换搜索引擎" aria-haspopup="menu" aria-expanded="false">
          <span class="search-engine-badge fav-wrap" style="--tab-color:${colorFor('google.com')}">
            <span class="fav-letter">${letterFor('google.com')}</span>
            ${faviconImgHtml(ENGINES[0].url, { eager: true })}
          </span>
        </button>
        <input type="text" class="search-input" placeholder="搜索或输入网址…" autocomplete="off" aria-label="搜索或输入网址" />
        <button type="button" class="search-ai-btn" title="AI 查询入口" aria-label="打开 AI 查询入口" aria-expanded="false" aria-controls="${aiPanelId}">
          <span class="search-ai-icon">✦</span>
        </button>
      </div>
      <div class="search-ai-panel hidden" id="${aiPanelId}">
        <div class="ai-panel-list">
          ${AI_PROVIDERS.map(p => `
            <button type="button" class="ai-entry" data-ai="${p.value}">
              <span class="ai-entry-icon fav-wrap" style="--tab-color:${colorFor(hostOfAi(p))}">
                <span class="fav-letter">${letterFor(hostOfAi(p))}</span>
                ${faviconImgHtml(p.favUrl || p.url, { eager: true })}
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
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', '选择搜索引擎');
    menu.innerHTML = ENGINES.map(e => {
      const host = new URL(e.url).hostname;
      return `
      <button type="button" class="search-engine-option" data-engine="${e.value}" role="menuitemradio" aria-checked="false">
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
      menu.querySelectorAll('.search-engine-option').forEach((opt) => {
        opt.setAttribute('aria-checked', String(opt.dataset.engine === def.value));
      });
    }
    applyEngineBadge();

    const onDocClick = (e) => {
      if (!menu.contains(e.target) && !engineBtn.contains(e.target)) {
        menu.classList.add('hidden');
        engineBtn.setAttribute('aria-expanded', 'false');
      }
      // 点 widget 外关闭 AI 面板（面板本身在 widget 内，点面板不算外部）
      if (!aiPanel.classList.contains('hidden') && !el.contains(e.target)) {
        aiPanel.classList.add('hidden');
        aiBtn.classList.remove('active');
        aiBtn.setAttribute('aria-expanded', 'false');
      }
    };

    engineBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = menu.classList.toggle('hidden');
      engineBtn.setAttribute('aria-expanded', String(!open));
      if (!open) {
        placePopover(menu, engineBtn, { width: 160 });
        menu.querySelector('.search-engine-option[aria-checked="true"]')?.focus();
      }
    });
    document.addEventListener('click', onDocClick);
    // Esc 关闭浮层，回到输入框，不打断键盘操作
    const onKeydown = (e) => {
      if (e.key !== 'Escape') return;
      if (!menu.classList.contains('hidden')) {
        menu.classList.add('hidden');
        engineBtn.setAttribute('aria-expanded', 'false');
        engineBtn.focus();
      } else if (!aiPanel.classList.contains('hidden')) {
        aiPanel.classList.add('hidden');
        aiBtn.classList.remove('active');
        aiBtn.setAttribute('aria-expanded', 'false');
        aiBtn.focus();
      }
    };
    document.addEventListener('keydown', onKeydown);
    wireFavicons(menu);
    menu.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const options = [...menu.querySelectorAll('.search-engine-option')];
      const idx = options.indexOf(document.activeElement);
      e.preventDefault();
      if (e.key === 'Home') options[0]?.focus();
      else if (e.key === 'End') options.at(-1)?.focus();
      else {
        const delta = e.key === 'ArrowDown' ? 1 : -1;
        options[(idx + delta + options.length) % options.length]?.focus();
      }
    });
    menu.addEventListener('click', async (e) => {
      const opt = e.target.closest('.search-engine-option');
      if (!opt) return;
      e.preventDefault();
      e.stopPropagation();
      data.engine = opt.dataset.engine;
      applyEngineBadge();
      menu.classList.add('hidden');
      engineBtn.setAttribute('aria-expanded', 'false');
      input.focus();
      if (api?.patchWidget) api.patchWidget({ engine: data.engine });
    });

    // AI 面板开合（点 AI 图标切换）
    aiBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const open = aiPanel.classList.toggle('hidden');
      aiBtn.classList.toggle('active', !open);
      aiBtn.setAttribute('aria-expanded', String(!open));
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
      document.removeEventListener('keydown', onKeydown);
      menu.remove();
    };
  },
};

// AI 入口 host（豆包对话页域名取主页域名以保持品牌色一致）
function hostOfAi(p) {
  try { return new URL(p.favUrl || p.url).hostname; } catch { return p.url; }
}
