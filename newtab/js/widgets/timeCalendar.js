// widgets/timeCalendar.js — 时间 + 日历 + 事务小组件
// 上半部分大数字时钟（默认到秒 + 时区偏移），下半部分紧凑月历。
// 日历支持：日期下方事务圆点标记、点日期弹出事务面板（body 弹层）。
// 事务来源两路：本地手写（data.events，存 widget 私有数据）+ 便利贴提醒事项
// （api.settings.stickyExtId 拉取 reminder/meeting 分类，只读展示）。
// 私有配置：hour24、showSeconds、showTimezone、weekStart

import { placePopover } from './popover.js';
import { fetchReminders } from '../bridge.js';

const WEEK_SUN = ['日', '一', '二', '三', '四', '五', '六'];
const WEEK_MON = ['一', '二', '三', '四', '五', '六', '日'];
const WEEK_CN = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// 把日期规整为本地 YYYY-M-D 键（无前导零，比较用）
function dayKey(d) {
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// 解析 ISO 提醒时间为 Date（无 remindAt / 非法值返回 null）
function parseRemindAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : d;
}

export default {
  key: 'timeCalendar',
  label: '时间 · 日历',
  description: '时钟（秒 + 时区）与月历合一，日历可添加事务、同步便利贴提醒',
  defaultData: { hour24: true, showSeconds: true, showTimezone: true, weekStart: 1, events: [] },
  config: [
    { key: 'hour24', label: '24 小时制', type: 'bool', default: true },
    { key: 'showSeconds', label: '显示秒', type: 'bool', default: true },
    { key: 'showTimezone', label: '显示时区', type: 'bool', default: true },
    { key: 'weekStart', label: '每周始于', type: 'select', default: 1, options: [
      { value: 0, label: '周日' },
      { value: 1, label: '周一' },
    ] },
  ],

  init(container, data, api) {
    if (!Array.isArray(data.events)) data.events = [];
    const el = document.createElement('div');
    el.className = 'time-calendar';
    el.innerHTML = `
      <div class="tc-top">
        <div class="tc-clock">
          <div class="tc-time">
            <span class="tc-hm"></span><span class="tc-ss"></span><span class="tc-meridiem"></span>
          </div>
          <div class="tc-tz"></div>
          <div class="tc-date"></div>
        </div>
        <div class="tc-cal">
          <div class="tc-cal-head">
            <button class="tc-nav" data-dir="-1" title="上个月">‹</button>
            <span class="tc-cal-title"></span>
            <button class="tc-sync" title="同步便利贴提醒事项">⟳</button>
            <button class="tc-nav" data-dir="1" title="下个月">›</button>
          </div>
          <div class="tc-cal-week"></div>
          <div class="tc-cal-days"></div>
        </div>
      </div>
    `;
    container.appendChild(el);

    const hmEl = el.querySelector('.tc-hm');
    const ssEl = el.querySelector('.tc-ss');
    const meridiemEl = el.querySelector('.tc-meridiem');
    const tzEl = el.querySelector('.tc-tz');
    const dateEl = el.querySelector('.tc-date');
    const titleEl = el.querySelector('.tc-cal-title');
    const weekEl = el.querySelector('.tc-cal-week');
    const daysEl = el.querySelector('.tc-cal-days');
    const syncBtn = el.querySelector('.tc-sync');

    const today = new Date();
    let viewYear = today.getFullYear();
    let viewMonth = today.getMonth();
    // 便利贴提醒事项（按日期分组）：{ 'YYYY-M-D': [{title, source}] }
    let synced = {};

    const pad = (x) => String(x).padStart(2, '0');

    // ---- 时钟：秒 + GMT 时区偏移 ----
    function tick() {
      const now = new Date();
      let h = now.getHours();
      let meridiem = '';
      if (!data.hour24) {
        meridiem = h >= 12 ? 'PM' : 'AM';
        h = h % 12 || 12;
      }
      hmEl.textContent = `${pad(h)}:${pad(now.getMinutes())}`;
      ssEl.textContent = data.showSeconds ? `:${pad(now.getSeconds())}` : '';
      meridiemEl.textContent = meridiem;
      // 时区：本地偏移 GMT+8 / GMT+5:30 形式
      if (data.showTimezone) {
        const off = -now.getTimezoneOffset();
        const sign = off >= 0 ? '+' : '-';
        const abs = Math.abs(off);
        const oh = Math.floor(abs / 60);
        const om = abs % 60;
        tzEl.textContent = `GMT${sign}${oh}${om ? ':' + pad(om) : ''}`;
      } else {
        tzEl.textContent = '';
      }
      dateEl.textContent = `${now.getFullYear()} 年 ${now.getMonth() + 1} 月 ${now.getDate()} 日 · ${WEEK_CN[now.getDay()]}`;
    }

    // ---- 便利贴提醒同步 ----
    const extId = api?.settings?.stickyExtId || '';
    async function syncReminders() {
      if (!extId) {
        synced = {};
        renderCalendar();
        return;
      }
      syncBtn.classList.add('tc-syncing');
      const res = await fetchReminders(extId);
      syncBtn.classList.remove('tc-syncing');
      if (!res.ok) {
        synced = {};
        renderCalendar();
        return;
      }
      const map = {};
      for (const r of (res.data || [])) {
        const d = parseRemindAt(r.remindAt);
        if (!d) continue;
        const key = dayKey(d);
        (map[key] = map[key] || []).push({ title: r.title || '提醒', source: 'sticky' });
      }
      synced = map;
      renderCalendar();
    }

    // 汇总某日期的事务：本地手写 + 便利贴同步
    function eventsOfDay(d) {
      const key = dayKey(d);
      return [
        ...(data.events.filter(ev => ev.date === key).map(ev => ({ title: ev.title, source: 'local' }))),
        ...(synced[key] || []),
      ];
    }

    // ---- 日历 ----
    function renderCalendar() {
      const weekStart = data.weekStart === 0 ? 0 : 1;
      const head = weekStart === 0 ? WEEK_SUN : WEEK_MON;
      weekEl.innerHTML = head.map(d => `<span class="tc-wd">${d}</span>`).join('');

      // 第一格：当月 1 号回退到周起始
      const first = new Date(viewYear, viewMonth, 1);
      const lead = (first.getDay() - weekStart + 7) % 7;
      const start = new Date(first);
      start.setDate(1 - lead);

      let html = '';
      for (let i = 0; i < 42; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const inMonth = d.getMonth() === viewMonth;
        const isToday = dayKey(d) === dayKey(today);
        const hasEvents = inMonth && eventsOfDay(d).length > 0;
        const cls = ['tc-day', inMonth ? '' : 'out', isToday ? 'today' : '', hasEvents ? 'has-events' : '']
          .filter(Boolean).join(' ');
        html += `<span class="${cls}" data-date="${dayKey(d)}">${d.getDate()}${hasEvents ? '<i class="tc-dot"></i>' : ''}</span>`;
      }
      daysEl.innerHTML = html;
      titleEl.textContent = `${viewYear} 年 ${viewMonth + 1} 月`;
    }

    // ---- 事务面板（挂 body，避免卡片裁剪） ----
    let panel = null;
    function closePanel() {
      if (panel) { panel.remove(); panel = null; }
    }

    function openPanel(anchor, d) {
      closePanel();
      panel = document.createElement('div');
      panel.className = 'tc-event-panel';
      renderPanel(d);
      document.body.appendChild(panel);
      placePopover(panel, anchor, { width: 260 });
    }

    // 重新渲染面板内容（添加/删除事务后调用）
    function renderPanel(d) {
      const key = dayKey(d);
      const list = data.events.filter(ev => ev.date === key);
      const syncedOfDay = synced[key] || [];
      panel.innerHTML = `
        <div class="tc-panel-head">
          <span>${d.getMonth() + 1} 月 ${d.getDate()} 日 · ${WEEK_CN[d.getDay()]}</span>
          <button class="tc-panel-close" title="关闭">✕</button>
        </div>
        <div class="tc-panel-list">
          ${list.length === 0 && syncedOfDay.length === 0 ? '<p class="tc-panel-empty">暂无事务</p>' : ''}
          ${list.map(ev => `
            <div class="tc-event-row">
              <span class="tc-event-text">${escapeHtml(ev.title)}</span>
              <button class="tc-event-del" data-id="${ev.id}" title="删除">✕</button>
            </div>
          `).join('')}
          ${syncedOfDay.map(ev => `
            <div class="tc-event-row synced" title="来自便利贴提醒事项">
              <span class="tc-event-text">⏰ ${escapeHtml(ev.title)}</span>
              <span class="tc-event-src">便利贴</span>
            </div>
          `).join('')}
        </div>
        <div class="tc-panel-add">
          <input type="text" class="tc-add-input" placeholder="添加事务，回车保存" maxlength="50" />
        </div>
      `;
      panel.querySelector('.tc-panel-close').addEventListener('click', closePanel);
      const addInput = panel.querySelector('.tc-add-input');
      addInput.addEventListener('keydown', async (e) => {
        if (e.key !== 'Enter') return;
        const title = addInput.value.trim();
        if (!title) return;
        data.events = [...data.events, { id: crypto.randomUUID(), date: key, title }];
        if (api?.patchWidget) api.patchWidget({ events: data.events });
        renderPanel(d);
        renderCalendar();
        addInput.focus();
      });
      panel.addEventListener('click', async (e) => {
        const del = e.target.closest('.tc-event-del');
        if (!del) return;
        data.events = data.events.filter(ev => ev.id !== del.dataset.id);
        if (api?.patchWidget) api.patchWidget({ events: data.events });
        renderPanel(d);
        renderCalendar();
      });
    }

    // 点击日历：nav 切月 / 日期开事务面板
    el.addEventListener('click', (e) => {
      const nav = e.target.closest('.tc-nav');
      if (nav) {
        const dir = +nav.dataset.dir;
        viewMonth += dir;
        if (viewMonth < 0) { viewMonth = 11; viewYear--; }
        if (viewMonth > 11) { viewMonth = 0; viewYear++; }
        closePanel();
        renderCalendar();
        return;
      }
      if (e.target.closest('.tc-sync')) {
        syncReminders();
        return;
      }
      const dayCell = e.target.closest('.tc-day');
      if (dayCell && dayCell.dataset.date) {
        const [y, m, dd] = dayCell.dataset.date.split('-').map(Number);
        openPanel(dayCell, new Date(y, m - 1, dd));
      }
    });

    syncBtn.addEventListener('click', (e) => e.stopPropagation());

    const onDocClick = (e) => {
      if (panel && !panel.contains(e.target) && !el.contains(e.target)) closePanel();
    };
    document.addEventListener('click', onDocClick);

    tick();
    const timer = setInterval(tick, 1000);
    renderCalendar();
    syncReminders(); // 初始化时自动同步一次（未配置 ID 时静默）

    return () => {
      clearInterval(timer);
      document.removeEventListener('click', onDocClick);
      closePanel();
    };
  },
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
