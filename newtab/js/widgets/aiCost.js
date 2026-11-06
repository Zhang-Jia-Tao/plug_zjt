// widgets/aiCost.js — AI 成本与配额
// 数据来自 AI 管理器的 ai:subscribe 快照；本组件只读展示，不发任何命令。
// 价格是公开单价的近似值，按参考汇率折算成人民币，仅用于同机会话的成本感知，不替代账单。

const BUDGET_DEFAULT = 100;

// 公开价目表以美元计价；界面统一按此参考汇率折算为人民币。
export const USD_TO_CNY = 7.2;

// 每百万 token 的美元参考价（input / cache read / output）。
// 模型价格会变，这里用于“量级判断”，界面明确标注“估算”。
const PRICES = [
  { re: /claude.*opus|opus/i, input: 15, cache: 1.5, output: 75 },
  { re: /claude.*sonnet|sonnet/i, input: 3, cache: 0.3, output: 15 },
  { re: /claude.*haiku|haiku/i, input: 0.8, cache: 0.08, output: 4 },
  { re: /deepseek.*reasoner|deepseek[-\s]?r1|r1\b/i, input: 0.55, cache: 0.14, output: 2.19 },
  { re: /deepseek/i, input: 0.27, cache: 0.07, output: 1.1 },
  { re: /gpt[-\s]?5|gpt5/i, input: 1.25, cache: 0.125, output: 10 },
  { re: /gpt[-\s]?4o|gpt4o/i, input: 2.5, cache: 1.25, output: 10 },
  { re: /o[34](?:-|$|\s)/i, input: 2, cache: 0.5, output: 8 },
  { re: /gemini.*pro/i, input: 1.25, cache: 0.31, output: 10 },
  { re: /gemini.*flash/i, input: 0.3, cache: 0.075, output: 2.5 },
  { re: /qwen|通义/i, input: 0.3, cache: 0.1, output: 1.2 },
  { re: /glm|chatglm/i, input: 0.2, cache: 0.05, output: 0.8 },
];
const LOCAL_RE = /ollama|lmstudio|lm studio|llamacpp|vllm|localai|local/i;
const FALLBACK_PRICE = { input: 2, cache: 0.2, output: 8 };

export function priceFor(model) {
  const text = String(model || '');
  if (LOCAL_RE.test(text)) return { input: 0, cache: 0, output: 0, local: true };
  const hit = PRICES.find((item) => item.re.test(text));
  return hit ? { input: hit.input, cache: hit.cache, output: hit.output, local: false } : { ...FALLBACK_PRICE, local: false };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function roundMoney(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function summarizeSessions(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const models = new Map();
  let input = 0;
  let cache = 0;
  let output = 0;
  let turns = 0;
  let cost = 0;

  for (const session of list) {
    const i = num(session?.sumIn);
    const c = num(session?.sumCacheRead);
    const o = num(session?.sumOut);
    const model = String(session?.model || session?.app || '未知模型');
    const p = priceFor(`${model} ${session?.app || ''}`);
    const itemCostUsd = (i / 1e6) * p.input + (c / 1e6) * p.cache + (o / 1e6) * p.output;
    const itemCost = itemCostUsd * USD_TO_CNY;
    input += i;
    cache += c;
    output += o;
    turns += num(session?.turns);
    cost += itemCost;

    const current = models.get(model) || { name: model, tokens: 0, cost: 0, count: 0, local: p.local };
    current.tokens += i + c + o;
    current.cost = roundMoney(current.cost + itemCost);
    current.count += 1;
    models.set(model, current);
  }

  return {
    count: list.length,
    input,
    cache,
    output,
    tokens: input + cache + output,
    turns,
    cost: roundMoney(cost),
    models: [...models.values()].sort((a, b) => b.cost - a.cost || b.tokens - a.tokens),
  };
}

export function formatTokens(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1).replace(/\.0$/, '')}m`;
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1).replace(/\.0$/, '')}k`;
  return String(Math.round(n));
}

export function formatCost(value) {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1) return `¥${n.toFixed(2)}`;
  if (n > 0) return `¥${n.toFixed(3)}`;
  return '¥0.00';
}

function formatBudget(value) {
  const n = Math.max(0, Number(value) || 0);
  return `¥${n.toFixed(n % 1 ? 1 : 0)}`;
}

function budgetValue(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : BUDGET_DEFAULT;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

export default {
  key: 'aiCost',
  label: 'AI 成本与配额',
  description: '汇总当前 AI 会话的 token、模型与人民币估算费用，辅助控制预算',
  defaultData: { budget: '100' },
  config: [
    {
      key: 'budget',
      label: '会话预算（人民币）',
      type: 'text',
      default: '100',
      placeholder: '100',
      hint: '按 1 USD ≈ 7.2 CNY 参考汇率估算；仅用于量级参考，不是账单。',
    },
  ],

  init(container, data, api) {
    const el = document.createElement('div');
    el.className = 'mini-widget ac-widget';
    el.innerHTML = `
      <div class="mini-head">
        <span class="mini-icon ac-icon" aria-hidden="true">✦</span>
        <div class="mini-copy">
          <div class="mini-title">AI 成本</div>
          <div class="mini-sub">正在连接 AI 监控…</div>
        </div>
        <div class="mini-actions">
          <button type="button" class="mini-iconbtn ac-retry" title="重新连接 AI 监控" aria-label="重新连接 AI 监控">↻</button>
        </div>
      </div>
      <div class="ac-body">
        <div class="ac-hero">
          <div class="ac-cost">--</div>
          <div class="ac-tokens">-- tokens</div>
        </div>
        <div class="ac-budget">
          <div class="ac-budget-label"><span>预算</span><b>¥100</b></div>
          <div class="ac-bar"><i></i></div>
        </div>
        <div class="mini-list ac-models"></div>
      </div>
    `;
    container.appendChild(el);

    const subEl = el.querySelector('.mini-sub');
    const costEl = el.querySelector('.ac-cost');
    const tokensEl = el.querySelector('.ac-tokens');
    const budgetLabelEl = el.querySelector('.ac-budget-label b');
    const barEl = el.querySelector('.ac-bar i');
    const modelsEl = el.querySelector('.ac-models');
    const retryBtn = el.querySelector('.ac-retry');

    let port = null;
    let retryTimer = 0;
    let stopped = false;
    let sessions = [];
    let hostError = '';

    const budget = budgetValue(data.budget);
    budgetLabelEl.textContent = formatBudget(budget);
    budgetLabelEl.title = '按 1 USD ≈ 7.2 CNY 参考汇率估算';

    function setSub(text, title = '') {
      subEl.textContent = text;
      subEl.title = title;
    }

    function renderEmpty(text, isError = false) {
      costEl.textContent = '--';
      tokensEl.textContent = '-- tokens';
      barEl.style.width = '0%';
      modelsEl.innerHTML = '';
      const state = document.createElement('div');
      state.className = `mini-state${isError ? ' mini-state-error' : ''}`;
      state.textContent = text;
      modelsEl.appendChild(state);
    }

    function render() {
      if (hostError) {
        setSub('AI Host 未连接');
        renderEmpty(hostError, true);
        return;
      }
      if (!sessions.length) {
        setSub('当前会话 · 等待数据');
        renderEmpty('暂无监控会话\n打开 Claude Code / Codex / DSH 后自动汇总');
        return;
      }

      const summary = summarizeSessions(sessions);
      const ratio = Math.min(1, summary.cost / budget);
      costEl.textContent = formatCost(summary.cost);
      tokensEl.textContent = `${formatTokens(summary.tokens)} tokens`;
      barEl.style.width = `${Math.round(ratio * 100)}%`;
      barEl.classList.toggle('over', ratio >= 0.9);
      budgetLabelEl.textContent = formatBudget(budget);
      setSub(`${summary.count} 个会话 · ${summary.turns} turns · 人民币估算`);
      costEl.title = '按公开单价与 1 USD ≈ 7.2 CNY 参考汇率估算，不是服务商账单';
      tokensEl.title = `输入 ${summary.input.toLocaleString()} · 缓存 ${summary.cache.toLocaleString()} · 输出 ${summary.output.toLocaleString()}`;

      const rows = summary.models.slice(0, 3);
      modelsEl.innerHTML = rows.map((model) => `
        <div class="mini-row ac-model-row">
          <span class="ac-model-dot${model.local ? ' local' : ''}" aria-hidden="true"></span>
          <span class="ac-model-name" title="${escapeHtml(model.name)}">${escapeHtml(model.name)}</span>
          <span class="ac-model-tokens">${formatTokens(model.tokens)}</span>
          <span class="ac-model-cost">${formatCost(model.cost)}</span>
        </div>
      `).join('');
    }

    function onMessage(message) {
      if (!message || message.action !== 'ai:event') return;
      const ev = message.payload;
      if (!ev || !ev.type) return;
      if (ev.type === 'snapshot' || ev.type === 'session') {
        hostError = '';
        sessions = Array.isArray(ev.sessions) ? ev.sessions : sessions;
        render();
      } else if (ev.type === 'host:error') {
        hostError = 'AI Host 未连接';
        sessions = [];
        render();
      } else if (ev.type === 'host:ready') {
        hostError = '';
        render();
      }
    }

    function scheduleReconnect() {
      if (stopped || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = 0;
        connect();
      }, 5000);
    }

    function connect() {
      if (stopped) return;
      if (port) return;
      try {
        port = chrome.runtime.connect({ name: 'ai:subscribe' });
      } catch {
        hostError = 'AI Host 未连接';
        render();
        scheduleReconnect();
        return;
      }
      port.onMessage.addListener(onMessage);
      port.onDisconnect.addListener(() => {
        port = null;
        if (stopped) return;
        hostError = 'AI Host 未连接';
        render();
        scheduleReconnect();
      });
    }

    function reconnect() {
      clearTimeout(retryTimer);
      retryTimer = 0;
      if (port) {
        try { port.disconnect(); } catch { /* ignore */ }
        port = null;
      }
      hostError = '';
      setSub('正在连接 AI 监控…');
      renderEmpty('正在连接 AI 监控…');
      connect();
    }

    retryBtn.addEventListener('click', reconnect);
    renderEmpty('正在连接 AI 监控…');
    connect();

    return () => {
      stopped = true;
      clearTimeout(retryTimer);
      if (port) {
        try { port.disconnect(); } catch { /* ignore */ }
        port = null;
      }
    };
  },
};
