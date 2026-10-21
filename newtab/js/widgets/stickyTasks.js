// widgets/stickyTasks.js — 便利贴任务小组件
// 通过 bridge.js 拉取「程序员便利贴」扩展的规划清单（task_list 分类），
// 逐条勾选后回写便利贴（触发其关联卡片「已完成」标题联动）。
// 未安装/未配置时显示提示，不阻塞。

import { fetchTaskNotes, toggleStickyTask } from '../bridge.js';

export default {
  key: 'stickyTasks',
  label: '便利贴任务',
  description: '读取便利贴扩展的规划清单，可勾选完成',
  defaultData: { showLimit: 10 },
  config: [
    { key: 'showLimit', label: '显示条数上限', type: 'select', default: 10, options: [
      { value: 5, label: '5 条' },
      { value: 10, label: '10 条' },
      { value: 20, label: '20 条' },
      { value: 0, label: '不限制' },
    ] },
  ],

  init(container, data, api) {
    const el = document.createElement('div');
    el.className = 'sticky-tasks';
    container.appendChild(el);

    let destroyed = false;

    async function render() {
      const extId = api.settings?.stickyExtId;
      if (!extId) {
        el.innerHTML = '<div class="st-empty">⚙ 设置中填写便利贴扩展 ID 后可用</div>';
        return;
      }
      const r = await fetchTaskNotes(extId);
      if (destroyed) return;
      if (!r.ok) {
        el.innerHTML = `<div class="st-error">未连接便利贴扩展：${r.message}</div>`;
        return;
      }
      const notes = Array.isArray(r.data) ? r.data : [];
      // 汇总所有规划清单的任务，记录归属
      let items = [];
      for (const n of notes) {
        for (const t of (Array.isArray(n.tasks) ? n.tasks : [])) {
          items.push({ noteId: n.id, taskId: t.id, text: t.text || n.title, done: !!t.done });
        }
      }
      if (items.length === 0) {
        el.innerHTML = '<div class="st-empty">便利贴中暂无规划清单任务</div>';
        return;
      }
      const limit = +data.showLimit || 0;
      if (limit > 0) items = items.slice(0, limit);
      el.innerHTML = items.map(t => `
        <label class="st-task ${t.done ? 'done' : ''}">
          <input type="checkbox" data-note="${t.noteId}" data-task="${t.taskId}" ${t.done ? 'checked' : ''} />
          <span class="st-text">${escapeHtml(t.text)}</span>
        </label>
      `).join('');
    }

    // 勾选 → 回写便利贴，成功后刷新
    el.addEventListener('change', async (e) => {
      const cb = e.target.closest('input[type="checkbox"]');
      if (!cb) return;
      const { note, task } = cb.dataset;
      cb.disabled = true;
      const r = await toggleStickyTask(api.settings?.stickyExtId, note, task);
      if (destroyed) return;
      cb.disabled = false;
      if (r.ok) {
        await render(); // 重新拉取（拿到最新勾选状态）
      } else {
        cb.checked = !cb.checked; // 失败回滚
        el.insertAdjacentHTML('afterbegin', `<div class="st-error" style="order:-1">操作失败：${r.message}</div>`);
      }
    });

    render();
    return () => { destroyed = true; };
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
