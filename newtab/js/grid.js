// grid.js — 网格渲染 + 拖拽换位 + 尺寸切换 + 编辑模式
// widget 实例按 state.widgets 数组顺序流式排布；拖拽 = 交换数组位置后重渲染
// （与便利贴扩展 sidepanel.js 的 enableDragSort 同套路）

import { WIDGETS } from './widgets/registry.js';

const SIZE_CYCLE = ['s', 'm', 'l'];

// 渲染整个网格：为每个 widget 实例建卡片并调 widget.init(container, data, api)
// handlers: { onReorder(ids), onResize(id, size), onRemove(id) }（编辑模式操作回调）
export function renderGrid(state, handlers) {
  const grid = document.getElementById('grid');
  // 先销毁旧实例（清定时器等）
  for (const el of grid.querySelectorAll('.widget')) {
    destroyWidget(el);
  }
  grid.innerHTML = '';

  if (state.widgets.length === 0) {
    grid.innerHTML = '<div class="grid-empty">暂无小组件，点右上角 ⚙ 添加</div>';
    return;
  }

  for (const w of state.widgets) {
    const def = WIDGETS.find(d => d.key === w.key);
    const el = document.createElement('div');
    el.className = `widget size-${w.size}`;
    el.dataset.id = w.id;
    el.draggable = true;

    // 内容容器（widget 自己渲染）
    const body = document.createElement('div');
    body.className = 'widget-body';
    el.appendChild(body);

    // 编辑模式工具：尺寸切换 + 删除
    const tools = document.createElement('div');
    tools.className = 'widget-tools';
    tools.innerHTML = `
      <button class="tool-size" title="切换尺寸（当前 ${w.size.toUpperCase()}）">⟳</button>
      <button class="tool-del" title="删除小组件">✕</button>
    `;
    tools.querySelector('.tool-size').addEventListener('click', (e) => {
      e.stopPropagation();
      const next = SIZE_CYCLE[(SIZE_CYCLE.indexOf(w.size) + 1) % SIZE_CYCLE.length];
      handlers.onResize(w.id, next);
    });
    tools.querySelector('.tool-del').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('删除该小组件？')) handlers.onRemove(w.id);
    });
    el.appendChild(tools);

    // 找不到定义（未来版本移除了某 widget）：显示占位
    if (!def) {
      body.innerHTML = `<div class="widget-missing">未知小组件：${w.key}</div>`;
    } else {
      // api 提供 patchWidget 私有配置更新能力（widget 内部设置用）
      const api = {
        patchWidget: (patch) => {
          w.data = { ...(w.data || {}), ...patch };
          handlers.onDataChange(w.id, patch);
        },
        settings: state.settings,
      };
      const cleanup = def.init(body, w.data || {}, api);
      el._widgetCleanup = typeof cleanup === 'function' ? cleanup : (def.destroy ? () => def.destroy(body) : null);
    }

    grid.appendChild(el);
  }

  enableDragSort(handlers.onReorder);
}

// 销毁单个 widget 元素的清理函数（重渲染前调用，避免定时器泄漏）
function destroyWidget(el) {
  if (typeof el._widgetCleanup === 'function') {
    try { el._widgetCleanup(); } catch {}
  }
  el._widgetCleanup = null;
}

// 拖拽换位：交换数组位置（复用便利贴 enableDragSort 模式）
function enableDragSort(onReorder) {
  const grid = document.getElementById('grid');
  let dragId = null;

  grid.ondragstart = (e) => {
    if (!document.body.classList.contains('editing')) return; // 仅编辑模式可拖
    const card = e.target.closest('.widget');
    if (!card) return;
    dragId = card.dataset.id;
    card.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragId); } catch {}
  };
  grid.ondragend = (e) => {
    const card = e.target.closest('.widget');
    if (card) card.classList.remove('dragging');
    grid.querySelectorAll('.widget').forEach(c => c.classList.remove('drag-over'));
    dragId = null;
  };
  grid.ondragover = (e) => {
    if (!dragId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const target = e.target.closest('.widget');
    if (!target || target.dataset.id === dragId) return;
    grid.querySelectorAll('.widget').forEach(c => c.classList.remove('drag-over'));
    target.classList.add('drag-over');
  };
  grid.ondrop = (e) => {
    e.preventDefault();
    const target = e.target.closest('.widget');
    if (!target || !dragId || target.dataset.id === dragId) return;
    // 按 DOM 顺序取 id 数组，把拖动项插到目标项之前
    const ids = [...grid.querySelectorAll('.widget')].map(c => c.dataset.id);
    const fromIdx = ids.indexOf(dragId);
    const toIdx = ids.indexOf(target.dataset.id);
    ids.splice(fromIdx, 1);
    ids.splice(toIdx, 0, dragId);
    grid.querySelectorAll('.widget').forEach(c => c.classList.remove('drag-over'));
    onReorder(ids);
  };
}
