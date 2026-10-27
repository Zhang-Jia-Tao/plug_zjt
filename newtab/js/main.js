// main.js — 新标签页入口
// 职责：加载状态、渲染网格、编辑模式切换、设置面板（主题/添加删除/widget 配置/联动 ID/恢复默认）

import { loadState, saveState, patchWidgetData, setWidgetSize, reorderWidgets, addWidget, removeWidget, resetState, BG_PRESETS } from './store.js';
import { renderGrid } from './grid.js';
import { WIDGETS } from './widgets/registry.js';
import { initBookmarkBar } from './bookmarksbar.js';
import { initAiManager } from './aimanager.js';
import { initSysMonitor } from './sysmonitor.js';
import { isOverlayLayout } from './layout.js';

let state = null;
// 面板惰性初始化：窄屏抽屉未打开时不连接 host，避免后台空轮询
let sysReady = false;
let aiReady = false;
// 抽屉态下当前打开的面板（不写回设置，关闭后仍可再次打开）
let overlayPanel = { sys: false, ai: false };
let lastOverlayMode = null;

const $ = (sel) => document.querySelector(sel);

// ---- 网格渲染（统一入口，所有变更后调用） ----
function refresh() {
  renderGrid(state, {
    onReorder: async (ids) => {
      await reorderWidgets(state, ids);
      refresh();
    },
    onResize: async (id, size) => {
      await setWidgetSize(state, id, size);
      refresh();
    },
    onRemove: async (id) => {
      await removeWidget(state, id);
      refresh();
      renderSettingsPanel();
    },
    onDataChange: async (id, patch) => {
      // widget 内部 api.patchWidget 已更新内存 state，这里只落盘
      await saveState(state);
    },
  });
}

// ---- 主题 ----
function applyTheme() {
  document.body.dataset.theme = state.settings.theme;
  applyBg();
}

// ---- 背景色 ----
// bgColor 为 'default' 时跟随主题变量，否则以十六进制色值内联覆盖
function applyBg() {
  const bg = state.settings.bgColor;
  document.body.dataset.bg = bg || 'default';
  if (bg && bg !== 'default') {
    document.body.style.backgroundColor = bg;
  } else {
    document.body.style.backgroundColor = '';
  }
}

// 让预设下拉 + 自定义取色器反映当前 bgColor（预设里没有的色值显示在取色器里）
function syncBgControls() {
  const bg = state.settings.bgColor || 'default';
  const presetValues = BG_PRESETS.map(p => p.value);
  const select = $('#s-bg-color');
  if (presetValues.includes(bg)) {
    select.value = bg;
    $('#s-bg-custom').value = bg === 'default' ? '#1e2129' : bg;
  } else {
    select.value = 'custom';
    $('#s-bg-custom').value = /^#[0-9a-fA-F]{6}$/.test(bg) ? bg : '#1e2129';
  }
}

// ---- 编辑模式 ----
function bindEditMode() {
  $('#btn-edit').addEventListener('click', () => {
    const editing = document.body.classList.toggle('editing');
    $('#btn-edit').classList.toggle('active', editing);
    $('#edit-hint').classList.toggle('hidden', !editing);
  });
  $('#btn-edit-done').addEventListener('click', () => {
    document.body.classList.remove('editing');
    $('#btn-edit').classList.remove('active');
    $('#edit-hint').classList.add('hidden');
  });
}

// ---- 左右面板：宽屏停靠 / 窄屏抽屉 ----
function ensureSysPanel() {
  if (sysReady) return;
  sysReady = true;
  initSysMonitor();
}

function ensureAiPanel() {
  if (aiReady) return;
  aiReady = true;
  initAiManager();
}

function currentOverlayMode() {
  return isOverlayLayout(
    window.innerWidth,
    state.settings.showSysPanel !== false,
    state.settings.showAiPanel !== false,
  );
}

function applyPanelLayout() {
  if (!state) return;
  const overlay = currentOverlayMode();
  if (overlay !== lastOverlayMode) {
    // 跨过断点时先收起抽屉，避免宽屏面板在窄屏自动盖住网格
    overlayPanel = { sys: false, ai: false };
    lastOverlayMode = overlay;
  }

  const sysOn = overlay ? overlayPanel.sys : state.settings.showSysPanel !== false;
  const aiOn = overlay ? overlayPanel.ai : state.settings.showAiPanel !== false;
  const panelOpen = overlay && (sysOn || aiOn);

  document.body.classList.toggle('panels-overlay', overlay);
  document.body.classList.toggle('sys-panel-on', sysOn);
  document.body.classList.toggle('ai-panel-on', aiOn);
  document.body.classList.toggle('panel-open', panelOpen);

  const scrim = $('#panel-scrim');
  if (scrim) scrim.classList.toggle('hidden', !panelOpen);

  for (const [which, on] of [['sys', sysOn], ['ai', aiOn]]) {
    const btn = $(`#btn-${which}`);
    btn?.classList.toggle('active', on);
    btn?.setAttribute('aria-pressed', String(on));
    $(`#${which}-panel`)?.setAttribute('aria-hidden', String(!on));
  }

  // 面板真正可见时才初始化，窄屏从未打开过的面板不建立 Native Messaging 订阅
  if (sysOn) ensureSysPanel();
  if (aiOn) ensureAiPanel();
}

// 写入面板偏好并同步布局；返回是否发生了停靠→抽屉切换
function setPanelPref(which, enabled, openDrawer = true) {
  const wasOverlay = currentOverlayMode();
  const key = which === 'sys' ? 'showSysPanel' : 'showAiPanel';
  state.settings[key] = enabled;
  const nowOverlay = currentOverlayMode();

  if (!enabled) overlayPanel[which] = false;
  if (!wasOverlay && nowOverlay && enabled && openDrawer) {
    // 在 1024–1279px 打开第二个面板时，布局会从停靠切到抽屉：
    // 把刚打开的面板作为抽屉保留，避免两个面板一起消失。
    overlayPanel = { sys: false, ai: false };
    overlayPanel[which] = true;
    lastOverlayMode = true;
  }

  applyPanelLayout();
  return { wasOverlay, nowOverlay };
}

function togglePanel(which) {
  if (!state) return;
  if (currentOverlayMode()) {
    const willOpen = !overlayPanel[which];
    overlayPanel = { sys: false, ai: false };
    overlayPanel[which] = willOpen;
    applyPanelLayout();
    if (willOpen) {
      requestAnimationFrame(() => $(`#${which}-close`)?.focus({ preventScroll: true }));
    }
    return;
  }

  const key = which === 'sys' ? 'showSysPanel' : 'showAiPanel';
  const willEnable = !(state.settings[key] !== false);
  const { wasOverlay, nowOverlay } = setPanelPref(which, willEnable);
  void saveState(state);
  if (!wasOverlay && nowOverlay && willEnable) {
    requestAnimationFrame(() => $(`#${which}-close`)?.focus({ preventScroll: true }));
  }
}

function closeOverlayPanel(which) {
  overlayPanel[which] = false;
  applyPanelLayout();
  $(`#btn-${which}`)?.focus({ preventScroll: true });
}

function closeOverlayPanels() {
  if (!document.body.classList.contains('panels-overlay')) return;
  const openWhich = overlayPanel.sys ? 'sys' : overlayPanel.ai ? 'ai' : null;
  overlayPanel = { sys: false, ai: false };
  applyPanelLayout();
  if (openWhich) $(`#btn-${openWhich}`)?.focus({ preventScroll: true });
}

function bindPanelLayout() {
  $('#btn-sys')?.addEventListener('click', () => togglePanel('sys'));
  $('#btn-ai')?.addEventListener('click', () => togglePanel('ai'));
  $('#sys-close')?.addEventListener('click', () => closeOverlayPanel('sys'));
  $('#ai-close')?.addEventListener('click', () => closeOverlayPanel('ai'));
  $('#panel-scrim')?.addEventListener('click', closeOverlayPanels);
  window.addEventListener('resize', applyPanelLayout);
}

// ---- 设置面板 ----
function openSettings() {
  closeOverlayPanels();
  $('#s-theme').value = state.settings.theme;
  $('#s-sticky-ext-id').value = state.settings.stickyExtId;
  $('#s-show-sys').checked = state.settings.showSysPanel !== false;
  $('#s-show-ai').checked = state.settings.showAiPanel !== false;
  syncBgControls();
  renderSettingsPanel();
  $('#settings').classList.remove('hidden');
  $('#settings').setAttribute('aria-hidden', 'false');
  document.body.classList.add('settings-open');
  requestAnimationFrame(() => $('#settings-close').focus({ preventScroll: true }));
}

function closeSettings() {
  $('#settings').classList.add('hidden');
  $('#settings').setAttribute('aria-hidden', 'true');
  document.body.classList.remove('settings-open');
  if (document.body.classList.contains('panel-open')) {
    const which = overlayPanel.sys ? 'sys' : 'ai';
    $(`#${which}-close`)?.focus({ preventScroll: true });
  } else {
    $('#btn-settings').focus({ preventScroll: true });
  }
}

// 渲染「添加小组件」列表 + 「小组件配置」列表
function renderSettingsPanel() {
  // 添加小组件：registry 中每个 widget 一个按钮
  const addList = $('#widget-add-list');
  addList.innerHTML = '';
  for (const def of WIDGETS) {
    const btn = document.createElement('button');
    btn.className = 'widget-add-btn';
    btn.textContent = `+ ${def.label}`;
    btn.title = def.description || def.label;
    btn.addEventListener('click', async () => {
      await addWidget(state, def.key, def.defaultData);
      refresh();
      renderSettingsPanel();
    });
    addList.appendChild(btn);
  }

  // 已有 widget 实例的配置表单
  const configList = $('#widget-config-list');
  configList.innerHTML = '';
  if (state.widgets.length === 0) {
    configList.innerHTML = '<p class="settings-tip">暂无小组件，从上方添加。</p>';
    return;
  }
  for (const w of state.widgets) {
    const def = WIDGETS.find(d => d.key === w.key);
    if (!def) continue;
    const item = document.createElement('div');
    item.className = 'widget-config-item';
    item.innerHTML = `
      <div class="wci-head">
        <span>${def.label} · ${w.size.toUpperCase()}</span>
        <button class="wci-remove" title="删除">✕ 删除</button>
      </div>
      ${buildConfigRows(w, def)}
    `;
    // 删除按钮
    item.querySelector('.wci-remove').addEventListener('click', async () => {
      await removeWidget(state, w.id);
      refresh();
      renderSettingsPanel();
    });
    // 配置行事件（select / checkbox）
    item.addEventListener('change', async (e) => {
      const key = e.target.dataset.cfg;
      if (!key) return;
      const val = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
      await patchWidgetData(state, w.id, { [key]: val });
      refresh();
    });
    configList.appendChild(item);
  }
}

// 按 widget 定义生成配置表单行（key 对应 data 字段名）
function buildConfigRows(w, def) {
  const rows = [];
  const cfg = def.config;
  if (!cfg) return '';
  for (const c of cfg) {
    const cur = w.data?.[c.key] ?? c.default;
    if (c.type === 'bool') {
      rows.push(`
        <label class="wci-row">
          <span>${c.label}</span>
          <input type="checkbox" data-cfg="${c.key}" ${cur ? 'checked' : ''} />
        </label>
      `);
    } else if (c.type === 'select') {
      rows.push(`
        <label class="wci-row">
          <span>${c.label}</span>
          <select data-cfg="${c.key}">
            ${c.options.map(o => `<option value="${o.value}" ${String(cur) === String(o.value) ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </label>
      `);
    }
  }
  return rows.join('');
}

function bindSettings() {
  $('#btn-settings').addEventListener('click', openSettings);
  $('#settings-close').addEventListener('click', closeSettings);
  // 点遮罩关闭
  $('#settings').addEventListener('click', (e) => {
    if (e.target === $('#settings')) closeSettings();
  });
  // 主题
  $('#s-theme').addEventListener('change', async (e) => {
    state.settings.theme = e.target.value;
    await saveState(state);
    applyTheme();
  });
  // 背景色：预设下拉
  $('#s-bg-color').addEventListener('change', async (e) => {
    const val = e.target.value;
    if (val === 'custom') return; // 自定义走取色器
    state.settings.bgColor = val;
    await saveState(state);
    applyBg();
    syncBgControls();
  });
  // 背景色：自定义取色器
  $('#s-bg-custom').addEventListener('input', async (e) => {
    state.settings.bgColor = e.target.value;
    await saveState(state);
    applyBg();
  });
  // 面板显示偏好
  $('#s-show-sys').addEventListener('change', async (e) => {
    setPanelPref('sys', e.target.checked, false);
    await saveState(state);
  });
  $('#s-show-ai').addEventListener('change', async (e) => {
    setPanelPref('ai', e.target.checked, false);
    await saveState(state);
  });
  // 便利贴扩展 ID
  $('#s-sticky-ext-id').addEventListener('change', async (e) => {
    state.settings.stickyExtId = e.target.value.trim();
    await saveState(state);
    refresh(); // 触发 stickyTasks 重新拉取
  });
  // 恢复默认
  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('恢复默认布局？当前小组件与配置将丢失。')) return;
    state = await resetState();
    applyTheme();
    refresh();
    renderSettingsPanel();
    $('#s-theme').value = state.settings.theme;
    $('#s-sticky-ext-id').value = state.settings.stickyExtId;
    $('#s-show-sys').checked = state.settings.showSysPanel !== false;
    $('#s-show-ai').checked = state.settings.showAiPanel !== false;
    syncBgControls();
    applyPanelLayout();
  });
  // ESC：优先关设置，其次关抽屉面板
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('#settings').classList.contains('hidden')) {
      closeSettings();
      return;
    }
    if (document.body.classList.contains('panel-open')) closeOverlayPanels();
  });
}

// ---- 本地目录树侧边栏（已禁用：把手隐藏，代码保留可随时恢复） ----
function bindTreeSidebar() {
  const sidebar = $('#tree-sidebar');
  const handle = $('#tree-handle');
  if (!handle || !sidebar) return;
  handle.addEventListener('click', () => {
    const open = sidebar.classList.toggle('hidden') === false;
    handle.classList.toggle('active', open);
    handle.innerHTML = '📁<span>目录</span>';
    handle.title = open ? '收起目录树' : '本地目录树';
    document.body.classList.toggle('tree-open', open);
  });
  $('#tree-toggle').addEventListener('click', () => {
    sidebar.classList.add('hidden');
    handle.classList.remove('active');
    document.body.classList.remove('tree-open');
  });
}

// ---- 入口 ----
async function init() {
  state = await loadState();
  applyTheme();
  refresh();
  bindEditMode();
  bindPanelLayout();
  bindSettings();
  bindTreeSidebar();
  initBookmarkBar();
  applyPanelLayout();
}

init();
