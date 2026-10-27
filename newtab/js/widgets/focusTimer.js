// widgets/focusTimer.js — 番茄钟 / 专注倒计时
// 纯前端、零权限：计时基于 endAt 时间戳，页面刷新/切换小组件后仍能继续。
// 状态落在 widget.data：minutes（时长）、endAt、remainingMs、running。
// 完成时用 Web Audio 轻提示音（无系统通知权限要求）。

const MINUTE = 60 * 1000;
const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

export default {
  key: 'focusTimer',
  label: '番茄钟',
  description: '专注倒计时，支持暂停/继续/重置，刷新页面后可继续计时',
  defaultData: { minutes: 25, endAt: 0, remainingMs: 25 * MINUTE, running: false },
  config: [
    { key: 'minutes', label: '专注时长', type: 'select', default: 25, options: [
      { value: 5, label: '5 分钟' },
      { value: 10, label: '10 分钟' },
      { value: 15, label: '15 分钟' },
      { value: 25, label: '25 分钟' },
      { value: 45, label: '45 分钟' },
      { value: 60, label: '60 分钟' },
    ] },
  ],

  init(container, data, api) {
    const totalMs = Math.max(1, Number(data.minutes) || 25) * MINUTE;
    const el = document.createElement('div');
    el.className = 'focus-timer';
    el.innerHTML = `
      <div class="ft-clock">
        <svg class="ft-ring" viewBox="0 0 120 120" aria-hidden="true">
          <circle class="ft-track" cx="60" cy="60" r="${RING_R}"></circle>
          <circle class="ft-progress" cx="60" cy="60" r="${RING_R}"></circle>
        </svg>
        <div class="ft-center">
          <div class="ft-time">25:00</div>
          <div class="ft-label">专注</div>
        </div>
      </div>
      <div class="ft-actions">
        <button type="button" class="ft-btn ft-primary ft-toggle">开始</button>
        <button type="button" class="ft-btn ft-reset">重置</button>
      </div>
    `;
    container.appendChild(el);

    const timeEl = el.querySelector('.ft-time');
    const labelEl = el.querySelector('.ft-label');
    const progressEl = el.querySelector('.ft-progress');
    const toggleBtn = el.querySelector('.ft-toggle');
    const resetBtn = el.querySelector('.ft-reset');

    progressEl.style.strokeDasharray = `${RING_C}`;

    // 恢复状态：running 且未到期 → 继续；running 但已到期 → 显示完成
    const now = Date.now();
    let endAt = Number(data.endAt) || 0;
    let running = false;
    let remaining;
    if (data.running && endAt > now) {
      running = true;
      remaining = endAt - now;
      // 运行中改了更短的时长：按新时长收敛，避免环已满却要等旧时长
      if (remaining > totalMs) {
        remaining = totalMs;
        endAt = now + totalMs;
      }
    } else if (data.running && endAt) {
      running = false;
      remaining = 0;
      endAt = 0;
    } else {
      remaining = Number(data.remainingMs);
      if (!Number.isFinite(remaining) || remaining < 0 || remaining > totalMs) remaining = totalMs;
    }

    function fmt(ms) {
      const totalSec = Math.max(0, Math.ceil(ms / 1000));
      return `${String(Math.floor(totalSec / 60)).padStart(2, '0')}:${String(totalSec % 60).padStart(2, '0')}`;
    }

    function paint() {
      const ratio = totalMs > 0 ? Math.max(0, Math.min(1, remaining / totalMs)) : 0;
      timeEl.textContent = fmt(remaining);
      progressEl.style.strokeDashoffset = `${RING_C * (1 - ratio)}`;
      labelEl.textContent = running
        ? '专注中'
        : (remaining <= 0 ? '完成' : (remaining < totalMs ? '已暂停' : '准备开始'));
      toggleBtn.textContent = running
        ? '暂停'
        : (remaining <= 0 ? '再来一次' : (remaining < totalMs ? '继续' : '开始'));
      el.classList.toggle('running', running);
      el.classList.toggle('done', !running && remaining <= 0);
    }

    // 只在状态切换时落盘，ticks 不写 storage
    function save() {
      data.endAt = endAt;
      data.remainingMs = remaining;
      data.running = running;
      if (api?.patchWidget) api.patchWidget({ endAt, remainingMs: remaining, running });
    }

    function start() {
      if (running) { pause(); return; }
      if (remaining <= 0) remaining = totalMs;
      unlockAudio(); // 在用户点击手势里解锁音频，完成提示音才不会被自动播放策略拦截
      endAt = Date.now() + remaining;
      running = true;
      save();
      paint();
    }

    function pause() {
      if (!running) return;
      remaining = Math.max(0, endAt - Date.now());
      running = false;
      endAt = 0;
      save();
      paint();
    }

    function reset() {
      running = false;
      endAt = 0;
      remaining = totalMs;
      save();
      paint();
    }

    function finish() {
      running = false;
      endAt = 0;
      remaining = 0;
      save();
      paint();
      beep();
    }

    toggleBtn.addEventListener('click', start);
    resetBtn.addEventListener('click', reset);

    const timer = setInterval(() => {
      if (!running) return;
      const left = endAt - Date.now();
      if (left <= 0) { finish(); return; }
      remaining = left;
      paint();
    }, 250);

    paint();
    if (running) save(); // 续期后把最新 remaining 落盘，避免异常退出后进度回跳

    return () => {
      // 只清本实例的定时器；AudioContext 是模块级共享资源，留给页面生命周期
      clearInterval(timer);
    };
  },
};

// 完成提示音：轻短的双音，不依赖系统通知权限
let audioCtx = null;

function unlockAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
  } catch { /* 忽略 */ }
}

function beep() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === 'suspended') void audioCtx.resume();
    const t = audioCtx.currentTime;
    for (const [freq, delay] of [[880, 0], [1174.66, 0.18]]) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      const at = t + delay;
      o.type = 'sine';
      o.frequency.setValueAtTime(freq, at);
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(0.15, at + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, at + 0.35);
      o.connect(g);
      g.connect(audioCtx.destination);
      o.start(at);
      o.stop(at + 0.4);
    }
  } catch { /* 音频不可用时静默 */ }
}
