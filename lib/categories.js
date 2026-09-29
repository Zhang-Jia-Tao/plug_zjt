// categories.js — 便利贴分类定义
// 每个分类：key（英文，用作文件夹名/存储标识）、label（中文显示）、color（色条/标签色）、icon（emoji）
// 使用 ES module，供 sidepanel/popup/options 复用。

export const CATEGORIES = [
  { key: 'test_env',     label: '测试环境', color: '#4CAF50', icon: '🧪' },
  { key: 'prod_env',     label: '正式环境', color: '#2196F3', icon: '🚀' },
  { key: 'account',      label: '测试账号', color: '#9C27B0', icon: '🔑' },
  { key: 'prod_account', label: '正式账号', color: '#673AB7', icon: '🔐' },
  { key: 'requirement',  label: '需求清单', color: '#FF9800', icon: '📋' },
  { key: 'task_list',    label: '规划清单', color: '#009688', icon: '✅' },
  { key: 'defect',       label: '缺陷修复', color: '#FF5722', icon: '🐛' },
  { key: 'bug',          label: 'BUG记录', color: '#F44336', icon: '🐞' },
  { key: 'url',          label: '网址链接', color: '#00BCD4', icon: '🔗' },
  { key: 'server_cmd',   label: '服务器命令', color: '#607D8B', icon: '🖥' },
  { key: 'reminder',     label: '提醒事项', color: '#FFC107', icon: '⏰' },
  { key: 'meeting',      label: '开会',     color: '#795548', icon: '📅' },
  { key: 'flash',        label: '快闪笔记', color: '#8BC34A', icon: '⚡' },
];

export const CATEGORY_MAP = Object.fromEntries(CATEGORIES.map(c => [c.key, c]));

export function getCategory(key) {
  return CATEGORY_MAP[key] || { key, label: key, color: '#999', icon: '📌' };
}

// 提醒/会议类需要 remindAt 字段；网址类需要 url 字段；账号类需要 username/password 字段
export const REMINDER_CATEGORIES = ['reminder', 'meeting'];
export const URL_CATEGORIES = ['url', 'test_env', 'prod_env'];
export const ACCOUNT_CATEGORIES = ['account', 'prod_account'];
// 规划清单任务可关联的卡片类别
export const LINKABLE_CATEGORIES = ['requirement', 'defect', 'bug'];
export const TASK_LIST_CATEGORY = 'task_list';
// 快闪笔记：编辑界面只保留内容框
export const FLASH_CATEGORY = 'flash';
// 测试/正式环境：编辑界面移除内容框（核心是网址）
export const ENV_CATEGORIES = ['test_env', 'prod_env'];
// 需求/缺陷/BUG：多内容块（可增删多个文本块）
export const MULTI_BLOCK_CATEGORIES = ['requirement', 'defect', 'bug'];
