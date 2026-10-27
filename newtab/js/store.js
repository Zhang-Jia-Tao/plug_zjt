// store.js — chrome.storage.local 读写
// 单键 newtab_state = { settings, widgets }，整体读写（数据量小，简单可靠）

const KEY = 'newtab_state';

// 状态结构版本号：新增默认组件等增量变更时 +1，
// 并在 migrateState 中补对应迁移逻辑（老用户自动升级，不动其已排好的布局）
const SCHEMA_VERSION = 8;

// 预置背景色（设置面板可选）
export const BG_PRESETS = [
  { value: 'default', label: '默认（跟随主题）' },
  { value: '#1a1d24', label: '深空灰' },
  { value: '#0f2027', label: '深海蓝' },
  { value: '#2d1b3d', label: '暗夜紫' },
  { value: '#1d2b1f', label: '森林绿' },
  { value: '#f2f4f8', label: '云白' },
  { value: '#fdf6ec', label: '米纸色' },
  { value: '#e8f0fe', label: '淡天蓝' },
];

export const DEFAULT_STATE = {
  settings: {
    theme: 'light',         // 'dark' | 'light'（底层画布默认白色）
    stickyExtId: '',        // 便利贴扩展 ID（跨扩展联动）
    bgColor: 'default',     // 背景色：'default' 跟随主题，或十六进制色值
    schemaVersion: SCHEMA_VERSION,
  },
  widgets: [
    { id: 'w-search',   key: 'search',       size: 'l', data: { engine: 'google', newTab: false } },
    { id: 'w-tc',       key: 'timeCalendar', size: 'm', data: { hour24: true, showSeconds: true, showTimezone: true, weekStart: 1, events: [] } },
    { id: 'w-sites',    key: 'topSites',     size: 'l', data: { showLimit: 10, newTab: false, customSites: [] } },
    { id: 'w-tasks',    key: 'stickyTasks',  size: 'm', data: { showLimit: 10 } },
    { id: 'w-focus',    key: 'focusTimer',   size: 'm', data: { minutes: 25, endAt: 0, remainingMs: 25 * 60 * 1000, running: false } },
    { id: 'w-music',    key: 'music',        size: 'm', data: { dirId: '', volume: 0.8, loop: false } },
  ],
};

// 读取全部状态（无数据时返回默认布局）
export async function loadState() {
  const { [KEY]: state } = await chrome.storage.local.get(KEY);
  if (!state || !Array.isArray(state.widgets)) return structuredClone(DEFAULT_STATE);
  const loaded = {
    settings: { ...DEFAULT_STATE.settings, ...(state.settings || {}) },
    widgets: state.widgets.filter(w => w && w.id && w.key),
  };
  const migrated = migrateState(loaded);
  if (migrated) await saveState(migrated); // 迁移结果落盘，避免每次加载重复迁移
  return migrated || loaded;
}

// 状态版本迁移：settings.schemaVersion 缺失/落后时升级旧数据
// 返回迁移后的新 state（无需迁移返回 null）
export function migrateState(state) {
  const version = state.settings.schemaVersion || 1;
  if (version >= SCHEMA_VERSION) return null;
  let migrated = structuredClone(state);
  migrated.settings.schemaVersion = SCHEMA_VERSION;

  // v1 -> v2：追加「搜索框 + 常用网站」两个仿谷歌组件（不动用户已有布局顺序）
  if (version < 2) {
    const keys = new Set(migrated.widgets.map(w => w.key));
    const additions = DEFAULT_STATE.widgets.filter(w =>
      (w.key === 'search' || w.key === 'topSites') && !keys.has(w.key)
    );
    migrated.widgets.push(...structuredClone(additions));
  }

  // v2 -> v3：旧的独立 clock/calendar 合并为 timeCalendar（保留用户配置）
  if (version < 3) {
    const keys = new Set(migrated.widgets.map(w => w.key));
    if (!keys.has('timeCalendar')) {
      const clock = migrated.widgets.find(w => w.key === 'clock');
      const cal = migrated.widgets.find(w => w.key === 'calendar');
      const size = (cal || clock)?.size || 'm';
      const data = {
        hour24: clock?.data?.hour24 ?? true,
        showSeconds: clock?.data?.showSeconds ?? false,
        weekStart: cal?.data?.weekStart ?? 1,
      };
      // 合并组件插到原 clock 位置（没有则追加到末尾）
      const insertIdx = migrated.widgets.findIndex(w => w.key === 'clock');
      const instance = { id: crypto.randomUUID(), key: 'timeCalendar', size, data };
      if (insertIdx >= 0) migrated.widgets.splice(insertIdx, 1, instance);
      else migrated.widgets.push(instance);
      // 移除旧的两个独立组件
      migrated.widgets = migrated.widgets.filter(w => w.key !== 'clock' && w.key !== 'calendar');
    }
  }
  // v3 -> v4：时间日历默认显示秒/时区（v3 前旧默认是 false）；补 events/customSites 数组
  if (version < 4) {
    for (const w of migrated.widgets) {
      if (w.key === 'timeCalendar') {
        w.data = w.data || {};
        w.data.showSeconds = true;             // 用户要求默认显示到秒
        if (w.data.showTimezone === undefined) w.data.showTimezone = true;
        if (!Array.isArray(w.data.events)) w.data.events = [];
      }
      if (w.key === 'topSites') {
        w.data = w.data || {};
        if (!Array.isArray(w.data.customSites)) w.data.customSites = [];
      }
    }
  }
  // v4 -> v5：追加本地音乐小组件（不动用户已有布局顺序）
  if (version < 5) {
    const keys = new Set(migrated.widgets.map(w => w.key));
    if (!keys.has('music')) {
      const def = DEFAULT_STATE.widgets.find(w => w.key === 'music');
      if (def) migrated.widgets.push(structuredClone(def));
    }
  }
  // v5 -> v6：音乐组件回退为 m（两列布局：左播放器/右列表），不再占用满宽
  if (version < 6) {
    for (const w of migrated.widgets) {
      if (w.key === 'music' && w.size === 'l') w.size = 'm';
    }
  }
  // v6 -> v7：页面底层画布由深色改为白色（默认主题切换为浅色，设置面板仍可切回深色）
  if (version < 7) {
    migrated.settings.theme = 'light';
  }
  // v7 -> v8：追加番茄钟小组件（不动已有布局顺序）
  if (version < 8) {
    const keys = new Set(migrated.widgets.map(w => w.key));
    if (!keys.has('focusTimer')) {
      const def = DEFAULT_STATE.widgets.find(w => w.key === 'focusTimer');
      if (def) migrated.widgets.push(structuredClone(def));
    }
  }
  return migrated;
}

// 整体保存
export async function saveState(state) {
  await chrome.storage.local.set({ [KEY]: state });
}

// 修改某个 widget 实例的私有配置（浅合并）
export async function patchWidgetData(state, widgetId, patch) {
  const w = state.widgets.find(x => x.id === widgetId);
  if (!w) return;
  w.data = { ...(w.data || {}), ...patch };
  await saveState(state);
}

// 修改某个 widget 实例的尺寸
export async function setWidgetSize(state, widgetId, size) {
  const w = state.widgets.find(x => x.id === widgetId);
  if (!w) return;
  w.size = size;
  await saveState(state);
}

// 按给定 id 顺序重排 widgets（拖拽换位用）
export async function reorderWidgets(state, orderedIds) {
  const byId = new Map(state.widgets.map(w => [w.id, w]));
  const next = orderedIds.map(id => byId.get(id)).filter(Boolean);
  // 容错：顺序数组遗漏的实例追加到末尾
  for (const w of state.widgets) {
    if (!next.includes(w)) next.push(w);
  }
  state.widgets = next;
  await saveState(state);
}

// 追加一个新 widget 实例
export async function addWidget(state, key, defaultData) {
  const w = {
    id: crypto.randomUUID(),
    key,
    size: 'm',
    data: { ...(defaultData || {}) },
  };
  state.widgets.push(w);
  await saveState(state);
  return w;
}

// 删除一个 widget 实例
export async function removeWidget(state, widgetId) {
  state.widgets = state.widgets.filter(w => w.id !== widgetId);
  await saveState(state);
}

// 恢复默认
export async function resetState() {
  const fresh = structuredClone(DEFAULT_STATE);
  await saveState(fresh);
  return fresh;
}
