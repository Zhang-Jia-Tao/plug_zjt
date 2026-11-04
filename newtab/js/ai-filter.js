// AI 管理器筛选：纯函数，方便在 Node 里回归测试「显示/收起离线」。
export function filterAiItems(items, currentFilter, includeOffline) {
  if (currentFilter === 'web') return items.filter(i => i.source === 'web');
  if (currentFilter === 'local') {
    return items.filter(i => i.source === 'local' && (includeOffline || i.status !== 'offline'));
  }
  return includeOffline ? items : items.filter(i => i.status !== 'offline');
}
