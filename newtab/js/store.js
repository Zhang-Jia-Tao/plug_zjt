// store.js — chrome.storage.local 读写
// 单键 newtab_state = { settings, widgets }，整体读写（数据量小，简单可靠）

const KEY = 'newtab_state';

// 并发写保护：
// - 同一页面内用 Promise 队列串行化；
// - 不同新标签页之间用 navigator.locks（Chrome 扩展页面支持）串行化；
// - 写入前读取最新状态，并把本页相对 baseState 的改动合并进去，避免 A 窗口
//   的主题/组件被 B 窗口的旧快照整体覆盖。
let baseState = null;
let baseRevision = 0;
let saveChain = Promise.resolve();

// 状态结构版本号：新增默认组件等增量变更时 +1，
// 并在 migrateState 中补对应迁移逻辑（老用户自动升级，不动其已排好的布局）
const SCHEMA_VERSION = 9;

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
    showSysPanel: true,     // 左侧系统资源面板是否停靠（窄屏改为抽屉）
    showAiPanel: true,      // 右侧 AI 管理器是否停靠（窄屏改为抽屉）
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

async function readStoredState() {
  const { [KEY]: state } = await chrome.storage.local.get(KEY);
  return state;
}

function normalizeState(raw) {
  if (!raw || !Array.isArray(raw.widgets)) {
    return { ...structuredClone(DEFAULT_STATE), _revision: 0 };
  }
  const loaded = {
    settings: { ...DEFAULT_STATE.settings, ...(raw.settings || {}) },
    widgets: raw.widgets.filter(w => w && w.id && w.key),
    _revision: Number(raw._revision) || 0,
  };
  const migrated = migrateState(loaded);
  return migrated || loaded;
}

// 读取全部状态（无数据时返回默认布局）
export async function loadState() {
  const raw = await readStoredState();
  const loaded = normalizeState(raw);
  baseState = structuredClone(loaded);
  baseRevision = Number(loaded._revision) || 0;
  // 旧 schema 迁移结果落盘。迁移必须用整体替换，不能走字段级合并：
  // 磁盘上的旧状态与 baseState 相同，合并会丢掉刚补上的默认组件。
  if (raw && raw.settings?.schemaVersion !== loaded.settings.schemaVersion) {
    await writeFreshState(loaded);
  }
  return loaded;
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
  // v8 -> v9：补回便利贴任务组件（旧布局或误删后缺失时；已有则不重复添加）
  if (version < 9) {
    const keys = new Set(migrated.widgets.map(w => w.key));
    if (!keys.has('stickyTasks')) {
      const def = DEFAULT_STATE.widgets.find(w => w.key === 'stickyTasks');
      if (def) migrated.widgets.push(structuredClone(def));
    }
  }
  return migrated;
}

function withStateLock(task) {
  const run = () => {
    if (globalThis.navigator?.locks?.request) {
      return navigator.locks.request('newtab_state_write', task);
    }
    return task();
  };
  const p = saveChain.then(run, run);
  saveChain = p.then(() => undefined, () => undefined);
  return p;
}

function jsonEqual(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// 把 next 合并回页面持有的 state，但保持 settings 对象、widget 对象和
// widget.data 的对象身份不变；组件 init/api.patchWidget 持有的是这些引用。
function syncValueInPlace(target, source) {
  if (Array.isArray(target) && Array.isArray(source)) {
    target.length = 0;
    target.push(...structuredClone(source));
    return target;
  }
  if (isPlainObject(target) && isPlainObject(source)) {
    for (const key of Object.keys(target)) {
      if (!(key in source)) delete target[key];
    }
    for (const key of Object.keys(source)) {
      const tv = target[key];
      const sv = source[key];
      if ((isPlainObject(tv) && isPlainObject(sv)) || (Array.isArray(tv) && Array.isArray(sv))) {
        syncValueInPlace(tv, sv);
      } else {
        target[key] = structuredClone(sv);
      }
    }
    return target;
  }
  return structuredClone(source);
}

function applyStateInPlace(state, next) {
  if (!state || typeof state !== 'object') return;
  if (!state.settings || typeof state.settings !== 'object') state.settings = {};
  syncValueInPlace(state.settings, next.settings || {});

  if (!Array.isArray(state.widgets)) state.widgets = [];
  const byId = new Map(state.widgets.map(w => [w.id, w]));
  const widgets = (next.widgets || []).map(nw => {
    const old = byId.get(nw.id);
    if (!old) return structuredClone(nw);
    old.size = nw.size;
    if (!old.data || typeof old.data !== 'object') old.data = {};
    syncValueInPlace(old.data, nw.data || {});
    return old;
  });
  state.widgets.splice(0, state.widgets.length, ...widgets);
  state._revision = next._revision;
}

// 把本页相对 base 的改动合并到 latest；没有改动过的字段保留其他窗口的最新值。
function mergeState(base, current, latest, removedIds = []) {
  const baseSettings = base?.settings || {};
  const curSettings = current?.settings || {};
  const settings = { ...(latest.settings || {}) };
  for (const key of Object.keys(curSettings)) {
    if (!jsonEqual(curSettings[key], baseSettings[key])) {
      settings[key] = structuredClone(curSettings[key]);
    }
  }

  const baseById = new Map((base?.widgets || []).map(w => [w.id, w]));
  const curById = new Map((current?.widgets || []).map(w => [w.id, w]));
  const latestById = new Map((latest.widgets || []).map(w => [w.id, structuredClone(w)]));

  // 只有显式删除（removeWidget）才从 latest 删除；当前页面快照里“缺少某个
  // 其他窗口新增的组件”并不等于用户删除了它。
  for (const id of removedIds) latestById.delete(id);
  // 本页新增或修改过的组件覆盖 latest；未改动的组件保留其他窗口的版本。
  for (const [id, w] of curById) {
    const before = baseById.get(id);
    if (!before || !jsonEqual(before, w)) latestById.set(id, structuredClone(w));
  }

  const baseOrder = (base?.widgets || []).map(w => w.id);
  const curOrder = (current?.widgets || []).map(w => w.id);
  const latestOrder = (latest.widgets || []).map(w => w.id);
  let order;
  if (!jsonEqual(baseOrder, curOrder)) {
    // 本页改过顺序：以本页顺序为准，其他窗口新增的组件追加到末尾。
    order = curOrder.filter(id => latestById.has(id));
    for (const id of latestOrder) {
      if (latestById.has(id) && !order.includes(id)) order.push(id);
    }
  } else {
    // 本页没改顺序：保留 latest 顺序，本页新增的组件追加到末尾。
    order = latestOrder.filter(id => latestById.has(id));
    for (const id of curOrder) {
      if (latestById.has(id) && !order.includes(id)) order.push(id);
    }
  }
  for (const id of latestById.keys()) {
    if (!order.includes(id)) order.push(id);
  }

  return {
    settings,
    widgets: order.map(id => latestById.get(id)).filter(Boolean),
  };
}

// 整体保存（带跨页合并）
// removedIds 只在明确删除组件时传：当前 state 缺少其他窗口新增的组件，
// 不能据此推断“用户删除了它”，否则下次保存会把对方的组件删掉。
export async function saveState(state, { removedIds = [] } = {}) {
  const snapshot = structuredClone(state);
  return withStateLock(async () => {
    const raw = await readStoredState();
    const latest = raw ? normalizeState(raw) : null;
    const latestRevision = Number(latest?._revision) || 0;
    const baseSnapshot = baseState;
    let next;
    if (!latest || !baseSnapshot) {
      next = snapshot;
    } else {
      // 即使 revision 相同也要合并：baseState 可能已包含其他窗口新增的组件，
      // 而当前页面还持有旧快照，直接写 snapshot 会把那些组件删掉。
      next = mergeState(baseSnapshot, snapshot, latest, removedIds);
    }
    next._revision = latestRevision + 1;
    await chrome.storage.local.set({ [KEY]: next });
    // 合并结果必须回写页面 state，否则页面仍是旧快照，下一次保存会把
    // “其他窗口改过、本页没动”的字段误判成本页修改。回写用原地同步，
    // 保持组件 init/api.patchWidget 持有的对象/data 引用不变。
    applyStateInPlace(state, next);
    baseState = structuredClone(next);
    baseRevision = next._revision;
    return next;
  });
}

async function writeFreshState(state) {
  return withStateLock(async () => {
    const raw = await readStoredState();
    const latestRevision = Number(raw?._revision) || 0;
    const next = { ...structuredClone(state), _revision: latestRevision + 1 };
    await chrome.storage.local.set({ [KEY]: next });
    baseState = structuredClone(next);
    baseRevision = next._revision;
    return next;
  });
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
  await saveState(state, { removedIds: [widgetId] });
}

// 恢复默认（整体替换，不做字段级合并）
export async function resetState() {
  const fresh = structuredClone(DEFAULT_STATE);
  return writeFreshState(fresh);
}
