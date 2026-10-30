// webai-sites.js — 网页端 AI 站点注册表
// 只存站点元数据；真正的状态采集在 content-webai.js，由 SW 统一聚合。
// hosts 用裸域名，matchWebAiSite 会同时匹配子域（www / chat 等）。

export const WEB_AI_SITES = [
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    hosts: ['chatgpt.com', 'chat.openai.com'],
    color: '#10a37f',
    short: 'GPT',
    detail: '网页会话',
  },
  {
    id: 'claude',
    name: 'Claude',
    hosts: ['claude.ai'],
    color: '#d97757',
    short: 'C',
    detail: '网页会话',
  },
  {
    id: 'gemini',
    name: 'Gemini',
    hosts: ['gemini.google.com'],
    color: '#4285f4',
    short: 'G',
    detail: '网页会话',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    hosts: ['chat.deepseek.com'],
    color: '#4d6bfe',
    short: 'D',
    detail: '网页会话',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    hosts: ['kimi.moonshot.cn', 'kimi.com'],
    color: '#7c3aed',
    short: 'K',
    detail: '网页会话',
  },
  {
    id: 'perplexity',
    name: 'Perplexity',
    hosts: ['perplexity.ai'],
    color: '#20808d',
    short: 'P',
    detail: '网页会话',
  },
  {
    id: 'grok',
    name: 'Grok',
    hosts: ['grok.com'],
    color: '#1f2937',
    short: 'X',
    detail: '网页会话',
  },
  {
    id: 'copilot',
    name: 'Copilot',
    hosts: ['copilot.microsoft.com'],
    color: '#0078d4',
    short: 'Co',
    detail: '网页会话',
  },
];

const SITE_BY_ID = new Map(WEB_AI_SITES.map(s => [s.id, s]));

function normalizeHost(hostname) {
  return String(hostname || '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '');
}

export function matchWebAiSite(hostname) {
  const host = normalizeHost(hostname);
  if (!host) return null;
  for (const site of WEB_AI_SITES) {
    for (const base of site.hosts) {
      const b = normalizeHost(base);
      if (host === b || host.endsWith('.' + b)) return site;
    }
  }
  return null;
}

export function webAiSiteById(id) {
  return SITE_BY_ID.get(String(id || '')) || null;
}
