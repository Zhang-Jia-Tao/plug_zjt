// main.js — 新标签页入口
// 职责：加载状态、渲染网格、编辑模式切换、设置面板（主题/添加删除/widget 配置/联动 ID/恢复默认）

import { loadState, saveState, patchWidgetData, setWidgetSize, reorderWidgets, addWidget, removeWidget, resetState, BG_PRESETS } from './store.js';
import { renderGrid } from './grid.js';
import { WIDGETS } from './widgets/registry.js';
import { initBookmarkBar } from './bookmarksbar.js';

let state = null;

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

// ---- 设置面板 ----
function openSettings() {
  $('#s-theme').value = state.settings.theme;
  $('#s-sticky-ext-id').value = state.settings.stickyExtId;
  syncBgControls();
  renderSettingsPanel();
  $('#settings').classList.remove('hidden');
}

function closeSettings() {
  $('#settings').classList.add('hidden');
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
    syncBgControls();
  });
  // ESC 关闭
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#settings').classList.contains('hidden')) closeSettings();
    }
  });
}

// ---- 本地目录树侧边栏（newtab 页内嵌，同网页版共用 tree.html） ----
function bindTreeSidebar() {
  const sidebar = $('#tree-sidebar');
  const handle = $('#tree-handle');
  handle.addEventListener('click', () => {
    const open = sidebar.classList.toggle('hidden') === false;
    handle.classList.toggle('active', open);
    handle.innerHTML = open ? '📁<span>目录</span>' : '📁<span>目录</span>';
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
  bindSettings();
  bindTreeSidebar();
  initBookmarkBar();
}

init();
