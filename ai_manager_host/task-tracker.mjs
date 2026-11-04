// task-tracker.mjs — 把 Claude / Codex / DSH 的日志事件归并成「一次任务」。
// 只做状态机和 token 增量，不读正文；host.mjs 负责从各日志解析出事件。
//
// 设计约束：
//   * 只有明确的完成事件或长时间无输出才结束任务；不能把「模型在思考」误判成空闲。
//   * 阻塞分等级：tool_slow / tool_blocked / first_token_slow / no_output / waiting_user。
//   * 完成后 durationMs 冻结，UI 的计时器不能再涨。

export const TASK_TIMINGS = Object.freeze({
  firstTokenMs: 15_000,
  toolSlowMs: 30_000,
  toolBlockedMs: 120_000,
  noOutputMs: 90_000,
  autoCompleteMs: 300_000,
});

function nowMs(now) {
  return typeof now === 'number' && Number.isFinite(now) ? now : Date.now();
}

function clampText(value, max = 160) {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

// UI 只拿脱敏后的动作：不广播完整 prompt / 工具输出，避免把密钥带进页面。
export function redactAction(text) {
  return clampText(text, 180)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,})\b/g, 'sk-***')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi, '$1***')
    .replace(/((?:token|secret|password|passwd|pwd|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1***');
}

export function actionTarget(name, input) {
  const tool = String(name || 'tool');
  let target = '';
  try {
    if (input && typeof input === 'object') {
      if (tool.toLowerCase() === 'bash' || tool.toLowerCase() === 'shell') target = input.command || input.description || '';
      else if (tool.toLowerCase() === 'pwsh' || tool.toLowerCase() === 'powershell') target = input.command || input.description || '';
      else if (tool.toLowerCase() === 'read' || tool.toLowerCase() === 'write' || tool.toLowerCase() === 'edit') target = input.file_path || input.path || '';
      else if (tool.toLowerCase() === 'grep') target = input.pattern || '';
      else if (tool.toLowerCase() === 'glob') target = input.pattern || '';
      else target = input.description || input.path || input.query || '';
    } else if (typeof input === 'string') {
      target = input;
    }
  } catch { target = ''; }
  return { name: tool, target: redactAction(target) };
}

export function createTask({
  app, id = '', project = '', model = '', startedAt = 0,
  phase = 'waiting_first_token', contextWindow = 0, ts = startedAt,
} = {}) {
  const at = nowMs(startedAt || ts);
  return {
    key: `${app}:${id || 'current'}`,
    app, id: String(id || ''), project: String(project || ''), model: String(model || ''),
    phase, phaseSince: at, startedAt: at, lastEventAt: at,
    completedAt: null, durationMs: null, outcome: null, done: false,
    blocked: null,
    action: null,
    turn: { input: 0, cacheRead: 0, output: 0, requests: 0, contextTokens: 0, contextWindow: Number(contextWindow) || 0 },
    total: { input: 0, cacheRead: 0, output: 0, requests: 0 },
    _tools: new Map(),
  };
}

function setPhase(task, phase, at) {
  if (!phase || task.done) return;
  if (task.phase !== phase) {
    task.phase = phase;
    task.phaseSince = at;
  }
  task.lastEventAt = Math.max(task.lastEventAt, at);
}

export function addTurnUsage(task, usage = {}, at = Date.now()) {
  if (task.done) return;
  const input = Math.max(0, Number(usage.input) || 0);
  const cacheRead = Math.max(0, Number(usage.cacheRead) || 0);
  const output = Math.max(0, Number(usage.output) || 0);
  task.turn.input += input;
  task.turn.cacheRead += cacheRead;
  task.turn.output += output;
  task.turn.requests += 1;
  // 最近一次请求的上下文 = 新输入 + 命中缓存；不是把每轮累加。
  if (input || cacheRead) task.turn.contextTokens = input + cacheRead;
  task.total.input += input;
  task.total.cacheRead += cacheRead;
  task.total.output += output;
  task.total.requests += 1;
  if (usage.contextWindow) task.turn.contextWindow = Number(usage.contextWindow) || 0;
  task.lastEventAt = Math.max(task.lastEventAt, at);
}

// 有些源（Codex）给的是会话累计快照，不是增量；这里只覆盖 total。
export function setTotalUsage(task, usage = {}, at = Date.now()) {
  if (task.done) return;
  if (usage.input != null) task.total.input = Math.max(0, Number(usage.input) || 0);
  if (usage.cacheRead != null) task.total.cacheRead = Math.max(0, Number(usage.cacheRead) || 0);
  if (usage.output != null) task.total.output = Math.max(0, Number(usage.output) || 0);
  task.lastEventAt = Math.max(task.lastEventAt, at);
}

function toolUse(task, event, at) {
  const callId = String(event.callId || event.toolUseId || 'tool');
  const info = actionTarget(event.name, event.input);
  const action = {
    kind: 'tool',
    name: info.name || 'tool',
    target: info.target || '',
    callId,
    status: 'running',
    startedAt: at,
    endedAt: null,
  };
  task._tools.set(callId, action);
  task.action = action;
  setPhase(task, 'tool_running', at);
}

function toolResult(task, event, at) {
  const callId = String(event.callId || event.toolUseId || 'tool');
  const action = task._tools.get(callId);
  if (action) {
    action.status = event.ok === false ? 'error' : 'done';
    action.endedAt = at;
    task._tools.delete(callId);
  }
  // 还有并行工具在跑时保留一个 running 动作，否则展示刚完成的动作。
  let running = null;
  for (const a of task._tools.values()) running = a;
  task.action = running || action || task.action;
  if (task.phase === 'tool_running') setPhase(task, 'thinking', at);
  else task.lastEventAt = Math.max(task.lastEventAt, at);
}

export function finishTask(task, { at = Date.now(), outcome = 'completed', durationMs = null, reason = '' } = {}) {
  if (!task || task.done) return task;
  const when = nowMs(at);
  task.done = true;
  task.completedAt = when;
  task.outcome = outcome;
  task.durationMs = durationMs != null && Number.isFinite(Number(durationMs))
    ? Math.max(0, Number(durationMs))
    : Math.max(0, when - task.startedAt);
  task.phase = outcome === 'failed' ? 'failed' : (outcome === 'ended' ? 'ended' : 'done');
  task.phaseSince = when;
  task.lastEventAt = Math.max(task.lastEventAt, when);
  task.blocked = null;
  if (task.action && task.action.status === 'running') {
    task.action.status = 'done';
    task.action.endedAt = when;
  }
  task._tools.clear();
  if (reason) task.outcomeReason = redactAction(reason);
  return task;
}

export function applyTaskEvent(task, event, now = Date.now()) {
  if (!task || !event || task.done) return false;
  const at = Number(event.at) || now;
  let changed = false;
  switch (event.type) {
    case 'meta':
      if (event.project && event.project !== task.project) { task.project = String(event.project); changed = true; }
      if (event.model && event.model !== task.model) { task.model = String(event.model); changed = true; }
      if (event.id && event.id !== task.id) { task.id = String(event.id); changed = true; }
      if (event.contextWindow) { task.turn.contextWindow = Number(event.contextWindow) || 0; changed = true; }
      task.lastEventAt = Math.max(task.lastEventAt, at);
      break;
    case 'phase':
      if (['thinking', 'streaming', 'waiting_first_token', 'tool_running'].includes(event.phase)) {
        setPhase(task, event.phase, at);
        clearTransientBlocked(task);
        changed = true;
      }
      break;
    case 'tool_use':
      clearTransientBlocked(task);
      toolUse(task, event, at);
      changed = true;
      break;
    case 'tool_result':
      clearTransientBlocked(task);
      toolResult(task, event, at);
      changed = true;
      break;
    case 'usage':
      clearTransientBlocked(task);
      addTurnUsage(task, event.usage, at);
      changed = true;
      break;
    case 'total_usage':
      setTotalUsage(task, event.usage, at);
      changed = true;
      break;
    case 'waiting_user':
      task.phase = 'waiting_user';
      task.phaseSince = at;
      task.lastEventAt = Math.max(task.lastEventAt, at);
      task.blocked = {
        kind: 'waiting_user',
        label: event.label ? redactAction(event.label) : '等待你确认',
        since: at,
        severity: 'action',
      };
      changed = true;
      break;
    case 'resume':
      if (task.phase === 'waiting_user') {
        task.phase = 'thinking';
        task.phaseSince = at;
      }
      task.blocked = null;
      task.lastEventAt = Math.max(task.lastEventAt, at);
      changed = true;
      break;
    case 'complete':
      finishTask(task, { at, outcome: event.outcome || 'completed', durationMs: event.durationMs, reason: event.reason });
      changed = true;
      break;
    case 'fail':
      finishTask(task, { at, outcome: 'failed', durationMs: event.durationMs, reason: event.reason || event.message });
      changed = true;
      break;
    case 'note':
      task.lastEventAt = Math.max(task.lastEventAt, at);
      changed = true;
      break;
    default:
      break;
  }
  return changed;
}

function setBlocked(task, blocked) {
  const cur = task.blocked;
  if (!cur && !blocked) return false;
  if (cur && blocked && cur.kind === blocked.kind && cur.severity === blocked.severity) return false;
  if (!cur && blocked) {
    task.blocked = blocked;
    return true;
  }
  if (cur && !blocked) {
    task.blocked = null;
    return true;
  }
  task.blocked = blocked;
  return true;
}

// 有新的真实活动就清掉临时告警；waiting_user 也会被后续日志推进解除
//（确认后通常先出现 tool_result/assistant，不一定有 dialog:closed）。
function clearTransientBlocked(task) {
  if (task.blocked) task.blocked = null;
}

export function tickTask(task, now = Date.now()) {
  if (!task || task.done) return false;
  const nowAt = nowMs(now);
  const idle = nowAt - task.lastEventAt;
  const phaseAge = nowAt - task.phaseSince;
  let blocked = null;

  if (task.phase === 'waiting_user') {
    blocked = { kind: 'waiting_user', label: '等待你确认', since: task.phaseSince, severity: 'action' };
  } else if (task.phase === 'tool_running') {
    if (phaseAge >= TASK_TIMINGS.toolBlockedMs) {
      blocked = { kind: 'tool_blocked', label: '工具可能卡住', since: task.phaseSince, severity: 'danger' };
    } else if (phaseAge >= TASK_TIMINGS.toolSlowMs) {
      blocked = { kind: 'tool_slow', label: '工具执行较慢', since: task.phaseSince, severity: 'warn' };
    }
  } else if (task.phase === 'waiting_first_token' && phaseAge >= TASK_TIMINGS.firstTokenMs) {
    blocked = { kind: 'first_token_slow', label: '等待模型首 token', since: task.phaseSince, severity: 'warn' };
  } else if (idle >= TASK_TIMINGS.noOutputMs) {
    blocked = { kind: 'no_output', label: '长时间没有新输出', since: task.lastEventAt, severity: 'warn' };
  }

  let changed = setBlocked(task, blocked);

  // 没有明确完成事件（Claude Code 本地日志通常没有 result）时，极长静默才收尾；
  // 此前一直保留在实时任务里并显示「无新输出」，不提前伪造完成。
  if (idle >= TASK_TIMINGS.autoCompleteMs && task.phase !== 'waiting_user' && task.phase !== 'tool_running') {
    finishTask(task, { at: nowAt, outcome: 'ended' });
    changed = true;
  }
  return changed;
}

export function publicTask(task, now = Date.now()) {
  const nowAt = nowMs(now);
  const active = !task.done;
  const elapsedMs = task.done ? (task.durationMs || 0) : Math.max(0, nowAt - task.startedAt);
  const phaseMs = task.done ? 0 : Math.max(0, nowAt - task.phaseSince);
  const action = task.action ? {
    kind: task.action.kind,
    name: task.action.name,
    target: task.action.target,
    status: task.action.status,
    startedAt: task.action.startedAt,
    endedAt: task.action.endedAt,
  } : null;
  return {
    key: task.key,
    // 同一会话会有多次任务；历史行/展开状态用「key + 开始时间」区分。
    historyKey: `${task.key}#${task.startedAt}`,
    app: task.app,
    id: task.id,
    project: task.project,
    model: task.model,
    phase: task.phase,
    active,
    done: task.done,
    startedAt: task.startedAt,
    phaseSince: task.phaseSince,
    lastEventAt: task.lastEventAt,
    completedAt: task.completedAt,
    durationMs: task.done ? elapsedMs : null,
    elapsedMs,
    phaseMs,
    outcome: task.outcome,
    outcomeReason: task.outcomeReason || '',
    blocked: task.blocked ? { ...task.blocked } : null,
    action,
    turn: { ...task.turn },
    total: { ...task.total },
  };
}

export class TaskTracker {
  constructor({ now = Date.now, historyLimit = 12 } = {}) {
    this.now = now;
    this.historyLimit = historyLimit;
    this.active = new Map();
    this.history = [];
  }

  start(info = {}) {
    const at = Number(info.startedAt) || this.now();
    const task = createTask({ ...info, startedAt: at, ts: at });
    const prev = this.active.get(task.key);
    if (prev) this.finish(prev, { at, outcome: 'superseded', reason: '新任务开始' });
    this.active.set(task.key, task);
    return task;
  }

  getActive(app, id) {
    if (id != null && id !== '') return this.active.get(`${app}:${id}`) || null;
    for (const task of this.active.values()) {
      if (task.app === app) return task;
    }
    return null;
  }

  apply(task, event) {
    const changed = applyTaskEvent(task, event, this.now());
    if (task && task.done && this.active.has(task.key)) {
      this.active.delete(task.key);
      this.history.unshift(task);
      this.history = this.history.slice(0, this.historyLimit);
    }
    return changed;
  }

  finish(task, { at = this.now(), outcome = 'completed', durationMs = null, reason = '' } = {}) {
    if (!task || !this.active.has(task.key)) return task;
    finishTask(task, { at, outcome, durationMs, reason });
    this.active.delete(task.key);
    this.history.unshift(task);
    this.history = this.history.slice(0, this.historyLimit);
    return task;
  }

  tick() {
    const now = this.now();
    let changed = false;
    for (const task of [...this.active.values()]) {
      if (!task) continue;
      changed = tickTask(task, now) || changed;
      if (task.done) {
        this.active.delete(task.key);
        this.history.unshift(task);
      }
    }
    this.history = this.history.slice(0, this.historyLimit);
    return changed;
  }

  snapshot() {
    const now = this.now();
    return {
      active: [...this.active.values()].map(t => publicTask(t, now)),
      recent: this.history.map(t => publicTask(t, now)),
    };
  }
}
