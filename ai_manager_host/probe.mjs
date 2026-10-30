// probe.mjs — 本地 AI HTTP 探测结果的纯函数
// 与 host.mjs 解耦，便于单测；不发起网络请求、不读文件。

// 从 OpenAI-compatible / Ollama / KoboldCpp / 通用 JSON 中提取模型名。
// 只认常见字段，返回去重后的短列表（UI 只展示前几个）；total 保留真实数量。
export function extractModelInfo(data) {
  const names = [];
  const push = (value) => {
    if (typeof value === 'string') {
      const s = value.replace(/\s+/g, ' ').trim();
      if (s) names.push(s);
      return;
    }
    if (value && typeof value === 'object') {
      const s = value.id || value.name || value.model || value.result || '';
      if (typeof s === 'string' && s.trim()) names.push(s.replace(/\s+/g, ' ').trim());
    }
  };

  if (Array.isArray(data)) {
    data.forEach(push);
  } else if (data && typeof data === 'object') {
    if (typeof data.result === 'string') push(data.result);
    const arr = data.data || data.models || data.model_list;
    if (Array.isArray(arr)) arr.forEach(push);
    else if (typeof arr === 'string') push(arr);
  }

  const unique = [...new Set(names.map(s => s.slice(0, 64)))];
  return { names: unique.slice(0, 8), total: unique.length };
}

export function extractModelNames(data) {
  return extractModelInfo(data).names;
}

// 把模型信息接到应用 detail 后面：base · qwen2.5:7b 等 3 个模型
export function formatAppDetail(base, models, total) {
  const list = (Array.isArray(models) ? models : []).filter(Boolean);
  if (list.length === 0) return String(base || '');
  const count = Number.isFinite(total) && total > list.length ? total : list.length;
  const first = String(list[0]).slice(0, 28);
  const suffix = count > 1 ? ` 等 ${count} 个模型` : '';
  return `${base ? base + ' · ' : ''}${first}${suffix}`;
}
