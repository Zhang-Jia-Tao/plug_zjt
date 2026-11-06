// widgets/registry.js — 小组件注册中心
// 新增 widget = 新建一个文件导出 { key, label, description, defaultData, init(container, data, api) }
// 并在下面 WIDGETS 数组加一行注册。init 返回清理函数（或 null）。

import timeCalendar from './timeCalendar.js';
import stickyTasks from './stickyTasks.js';
import focusTimer from './focusTimer.js';
import search from './search.js';
import topSites from './topSites.js';
import music from './music.js';
import javaNotes from './javaNotes.js';
import githubRanking from './githubRanking.js';
import githubWorkbench from './githubWorkbench.js';
import aiCost from './aiCost.js';
import dependencyRadar from './dependencyRadar.js';
import promptVault from './promptVault.js';
import devServices from './devServices.js';

export const WIDGETS = [
  timeCalendar,
  stickyTasks,
  focusTimer,
  search,
  topSites,
  githubRanking,
  githubWorkbench,
  aiCost,
  dependencyRadar,
  promptVault,
  devServices,
  music,
  javaNotes,
];
