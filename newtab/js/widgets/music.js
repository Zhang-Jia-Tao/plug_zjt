// widgets/music.js — 本地音乐播放小组件
// 数据源：本地音乐目录（File System Access 句柄，存共享 IDB，与目录树同库）。
// 播放机制：本页直接从 IDB 取目录句柄 → getFileHandle().getFile() → Blob URL → <audio>。
// 音频数据全程不经过 SW（MV3 SW 内存受限，100MB flac 经消息/port 传输会失败），
// 只有目录列表扫描这种小数据走 SW 消息。
// 首次使用点「选择音乐目录」在面板内直接调起系统选择器（直写 IDB）。
// 私有配置：dirId（音乐目录句柄 ID）、volume、loopMode（off/all/one）、shuffle（随机）

import { saveDirHandle, getDirHandle } from '../handle-store.js';

const AUDIO_HINT = '本地音乐目录（FLAC/MP3 等）';

export default {
  key: 'music',
  label: '本地音乐',
  description: '播放本地音乐目录中的歌曲（FLAC/MP3/M4A 等）',
  defaultData: { dirId: '', volume: 0.8, loopMode: 'off', shuffle: false },
  config: [
    { key: 'loopMode', label: '循环模式', type: 'select', default: 'off', options: [
      { value: 'off', label: '不循环' },
      { value: 'all', label: '列表循环' },
      { value: 'one', label: '单曲循环' },
    ] },
    { key: 'shuffle', label: '随机播放', type: 'bool', default: false },
  ],

  init(container, data, api) {
    const el = document.createElement('div');
    el.className = 'music-widget';
    container.appendChild(el);

    // 兼容旧数据：旧版只有 loop 布尔值（单曲循环）；新版合并为三态 loopMode。
    if (!['off', 'all', 'one'].includes(data.loopMode)) {
      data.loopMode = data.loop ? 'one' : 'off';
    }

    const state = {
      songs: [],        // [{ name, size }]
      current: -1,      // 当前曲目下标
      blobUrl: null,    // 当前曲目的 Blob URL（切歌时回收）
      dirName: '',
    };
    let audio = null;

    function call(action, payload = {}) {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ action, payload }, (res) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, message: chrome.runtime.lastError.message });
            return;
          }
          resolve(res || { ok: false, message: '无响应' });
        });
      });
    }

    // 页面直读音频文件：IDB 句柄 → getFileHandle → File 对象。
    // File/Blob 可直接交给 <audio>（无需读进内存），比 Blob URL 更省内存且无大小限制。
    // 权限：页面上下文中 queryPermission granted 即可用（首次授权发生在 pickDir 的手势链）。
    async function getAudioFile(fileName) {
      const entry = await getDirHandle(data.dirId);
      if (!entry) throw new Error('音乐目录不存在，请重新选择');
      const perm = await entry.handle.queryPermission({ mode: 'read' });
      if (perm !== 'granted') throw new Error('目录权限已失效，请重新选择目录');
      const fh = await entry.handle.getFileHandle(fileName);
      const file = await fh.getFile();
      if (file.size === 0) throw new Error('文件为空');
      return file;
    }

    // ---- 无目录：引导选择 ----
    function renderEmpty() {
      el.innerHTML = `
        <div class="music-empty">
          <div class="music-empty-icon">🎵</div>
          <p class="music-empty-tip">尚未指定音乐目录</p>
          <button class="music-pick-btn">选择音乐目录</button>
          <p class="music-empty-hint">${AUDIO_HINT}</p>
        </div>
      `;
      el.querySelector('.music-pick-btn').addEventListener('click', pickDir);
    }

    async function pickDir() {
      try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const perm = await handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted') {
          const granted = await handle.requestPermission({ mode: 'readwrite' });
          if (granted !== 'granted') throw new Error('未授予目录访问权限');
        }
        const id = crypto.randomUUID();
        await saveDirHandle({ id, name: handle.name, handle });
        data.dirId = id;
        if (api?.patchWidget) api.patchWidget({ dirId: id });
        loadSongs();
      } catch (e) {
        if (e && e.name === 'AbortError') return; // 用户取消
        el.querySelector('.music-empty-tip').textContent = e.message || String(e);
      }
    }

    // ---- 加载曲目列表 ----
    async function loadSongs() {
      if (!data.dirId) { renderEmpty(); return; }
      const res = await call('music:scan', { dirId: data.dirId });
      if (!res.ok) {
        // 目录句柄失效（IDB 被清/换浏览器）→ 回到引导
        data.dirId = '';
        if (api?.patchWidget) api.patchWidget({ dirId: '' });
        renderEmpty();
        el.querySelector('.music-empty-tip').textContent = res.message;
        return;
      }
      state.songs = res.data.songs;
      state.dirName = res.data.dirName;
      state.current = state.songs.length > 0 ? 0 : -1;
      renderPlayer();
    }

    // ---- 播放器 UI ----
    function renderPlayer() {
      if (state.songs.length === 0) {
        el.innerHTML = `
          <div class="music-empty">
            <div class="music-empty-icon">🎵</div>
            <p class="music-empty-tip">目录中没有音频文件</p>
            <button class="music-pick-btn">重新选择目录</button>
          </div>
        `;
        el.querySelector('.music-pick-btn').addEventListener('click', pickDir);
        return;
      }
      el.innerHTML = `
        <div class="music-player">
          <!-- 左列：唱片+曲目+控制+进度+小猫 -->
          <div class="music-main">
            <div class="music-info">
              <div class="music-disc">
                <span class="music-disc-icon">💿</span>
              </div>
              <div class="music-meta">
                <div class="music-title-marquee"><div class="music-title"></div></div>
                <div class="music-sub"></div>
              </div>
              <div class="music-mode" role="group" aria-label="播放模式">
                <button class="music-btn music-mode-btn" data-act="shuffle" title="随机播放" aria-label="随机播放" aria-pressed="false">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/></svg>
                </button>
                <button class="music-btn music-mode-btn" data-act="loop" title="循环关闭" aria-label="循环模式" aria-pressed="false">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m17 2 4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                  <span class="music-mode-badge" aria-hidden="true"></span>
                </button>
              </div>
            </div>
            <div class="music-controls">
              <button class="music-btn" data-act="prev" title="上一首" aria-label="上一首">⏮</button>
              <button class="music-btn music-play" data-act="play" title="播放/暂停" aria-label="播放">▶</button>
              <button class="music-btn" data-act="next" title="下一首" aria-label="下一首">⏭</button>
            </div>
            <div class="music-progress">
              <span class="music-time-cur">0:00</span>
              <div class="music-progress-bar">
                <div class="music-progress-fill"></div>
                <div class="music-cat" title="🎵 跟随播放进度">
                  <span class="music-cat-body">🐱</span>
                </div>
              </div>
              <span class="music-time-total">0:00</span>
            </div>
            <div class="music-bottom">
              <span class="music-count"></span>
              <div class="music-volume">
                <span class="music-vol-icon" title="音量">🔊</span>
                <input type="range" class="music-vol-range" min="0" max="100" value="${Math.round((data.volume ?? 0.8) * 100)}" />
              </div>
            </div>
          </div>
          <!-- 右列：播放列表（独立滚动） -->
          <div class="music-playlist">
            <div class="music-playlist-head">
              <span class="music-playlist-title">列表</span>
              <span class="music-playlist-count"></span>
              <button class="music-repick" title="重新选择音乐目录">⟳</button>
            </div>
            <div class="music-playlist-body"></div>
          </div>
        </div>
        <audio class="hidden"></audio>
      `;

      audio = el.querySelector('audio');
      audio.preload = 'auto';
      audio.volume = data.volume ?? 0.8;
      // 循环/随机由 ended 处理器统一决定；不要用 audio.loop，否则单曲会盖住列表逻辑。
      audio.loop = false;
      audio.addEventListener('timeupdate', onTimeUpdate);
      audio.addEventListener('ended', onEnded);
      audio.addEventListener('loadedmetadata', () => {
        el.querySelector('.music-time-total').textContent = fmtTime(audio.duration);
      });
      // 播放失败上报（解码失败/文件损坏时能看见原因，而不是静默无声）
      audio.addEventListener('error', () => {
        const errCode = audio.error?.code;
        const msgs = { 1: '加载中止', 2: '网络错误', 3: '解码失败', 4: '格式不支持' };
        el.querySelector('.music-sub').textContent = `播放错误：${msgs[errCode] || '未知'}（code ${errCode}）`;
      });

      el.querySelector('.music-vol-range').addEventListener('input', (e) => {
        data.volume = +e.target.value / 100;
        if (audio) audio.volume = data.volume;
        if (api?.patchWidget) api.patchWidget({ volume: data.volume });
      });

      el.querySelector('.music-controls').addEventListener('click', (e) => {
        const btn = e.target.closest('.music-btn');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'prev') playIndex(nextIndex(-1));
        else if (act === 'next') playIndex(nextIndex(1));
        else if (act === 'play') togglePlay();
      });

      // 模式按钮在 .music-info 内，不在 .music-controls 里，必须单独委托。
      el.querySelector('.music-mode').addEventListener('click', (e) => {
        const btn = e.target.closest('.music-btn');
        if (!btn) return;
        const act = btn.dataset.act;
        if (act === 'loop') {
          // 单键三态：关闭 → 列表循环 → 单曲循环 → 关闭
          const order = ['off', 'all', 'one'];
          const cur = order.includes(data.loopMode) ? data.loopMode : 'off';
          data.loopMode = order[(order.indexOf(cur) + 1) % order.length];
          if (api?.patchWidget) api.patchWidget({ loopMode: data.loopMode });
        } else if (act === 'shuffle') {
          data.shuffle = !data.shuffle;
          if (api?.patchWidget) api.patchWidget({ shuffle: !!data.shuffle });
        } else {
          return;
        }
        syncModeBtns();
      });

      el.querySelector('.music-progress-bar').addEventListener('click', (e) => {
        if (!audio || !audio.duration) return;
        const r = e.currentTarget.getBoundingClientRect();
        audio.currentTime = ((e.clientX - r.left) / r.width) * audio.duration;
      });

      el.querySelector('.music-repick').addEventListener('click', pickDir);

      el.querySelector('.music-playlist-body').addEventListener('click', (e) => {
        const item = e.target.closest('.music-pl-item');
        if (item) playIndex(+item.dataset.index);
      });

      renderPlaylist();
      syncModeBtns();
      updatePlayBtn();
      syncPlaylistCount();
      // 加载第一首（不自动播放，等用户点 ▶）
      if (state.current >= 0) playIndex(state.current, { autoplay: false });
    }

    // 播放列表总数（头部右侧）
    function syncPlaylistCount() {
      const c = el.querySelector('.music-playlist-count');
      if (c) c.textContent = state.songs.length > 0 ? `${state.songs.length} 首` : '';
    }

    // 歌名超长滚动（跑马灯）：文字宽度超过可视区时启用 CSS 滚动动画
    function startMarquee(text) {
      const title = el.querySelector('.music-title');
      const wrap = el.querySelector('.music-title-marquee');
      if (!title || !wrap) return;
      title.textContent = text;
      const overflow = title.scrollWidth - wrap.clientWidth;
      if (overflow > 8) {
        // 滚动距离 = 溢出量 + 缓冲；时长按 30px/s 换算（CSS 变量传入）
        const dist = overflow + 24;
        wrap.style.setProperty('--marquee-dist', `${dist}px`);
        wrap.style.setProperty('--marquee-dur', `${(dist / 30).toFixed(1)}s`);
        wrap.classList.add('scrolling');
      } else {
        wrap.classList.remove('scrolling');
        wrap.style.removeProperty('--marquee-dist');
        wrap.style.removeProperty('--marquee-dur');
      }
    }

    function renderPlaylist() {
      const body = el.querySelector('.music-playlist-body');
      body.innerHTML = state.songs.map((s, i) => `
        <div class="music-pl-item ${i === state.current ? 'active' : ''}" data-index="${i}" title="${escapeAttr(s.name)}">
          <span class="music-pl-name">${escapeHtml(cleanName(s.name))}</span>
          <span class="music-pl-size">${fmtSize(s.size)}</span>
        </div>
      `).join('');
    }

    function syncModeBtns() {
      const shuffleBtn = el.querySelector('[data-act="shuffle"]');
      if (shuffleBtn) {
        shuffleBtn.classList.toggle('active', !!data.shuffle);
        shuffleBtn.setAttribute('aria-pressed', String(!!data.shuffle));
      }
      const loopBtn = el.querySelector('[data-act="loop"]');
      if (loopBtn) {
        const mode = data.loopMode || 'off';
        const label = mode === 'one' ? '单曲循环' : mode === 'all' ? '列表循环' : '循环关闭';
        loopBtn.classList.toggle('active', mode !== 'off');
        loopBtn.dataset.mode = mode;
        loopBtn.title = label;
        loopBtn.setAttribute('aria-label', label);
        loopBtn.setAttribute('aria-pressed', String(mode !== 'off'));
        const badge = loopBtn.querySelector('.music-mode-badge');
        if (badge) badge.textContent = mode === 'one' ? '1' : '';
      }
    }

    // 下一首/上一首：随机模式优先随机；手动切歌时始终可循环。
    // auto=true（自然播放结束）时，未开循环且已到末尾则返回 -1 停止。
    function nextIndex(delta, { auto = false } = {}) {
      const n = state.songs.length;
      if (n === 0) return -1;
      if (data.shuffle && n > 1) {
        let idx = state.current;
        while (idx === state.current) idx = Math.floor(Math.random() * n);
        return idx;
      }
      const raw = state.current + delta;
      if (auto && data.loopMode === 'off' && (raw >= n || raw < 0)) return -1;
      return (raw + n) % n;
    }

    function updatePlayBtn() {
      const btn = el.querySelector('.music-play');
      if (!btn || !audio) return;
      btn.textContent = audio.paused ? '▶' : '⏸';
      btn.setAttribute('aria-label', audio.paused ? '播放' : '暂停');
      btn.title = audio.paused ? '播放' : '暂停';
    }

    // ---- 播放控制 ----
    async function playIndex(index, { autoplay = true } = {}) {
      if (state.songs.length === 0) return;
      // 边界由 nextIndex() 统一处理；-1 表示“未开循环且已到末尾，停止”。
      if (index < 0 || index >= state.songs.length) return;
      state.current = index;
      const song = state.songs[index];
      // UI 先更新（读盘期间即显示曲目名）
      el.querySelector('.music-title').textContent = cleanName(song.name);
      startMarquee(cleanName(song.name));
      el.querySelector('.music-sub').textContent = state.dirName;
      el.querySelector('.music-count').textContent = `${index + 1} / ${state.songs.length}`;
      renderPlaylist();

      // 页面直读：File 对象直接交给 audio（不进内存、不过 SW）
      const sub = el.querySelector('.music-sub');
      sub.textContent = '读取中…';
      let file;
      try {
        file = await getAudioFile(song.name);
      } catch (e) {
        sub.textContent = e.message || String(e);
        return;
      }
      sub.textContent = state.dirName;
      // 回收旧 URL；File 对象本身可直接作 src，但为兼容统一走 Blob URL
      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
      state.blobUrl = URL.createObjectURL(file);
      audio.src = state.blobUrl;
      audio.load(); // 立即触发元数据加载（时长显示）
      if (autoplay) {
        try { await audio.play(); } catch { /* 自动播放策略拦截：等待用户手动点播放 */ }
      }
      updatePlayBtn();
      // 旋转唱片
      el.querySelector('.music-disc')?.classList.toggle('playing', autoplay);
    }

    async function togglePlay() {
      if (!audio || !audio.src) return;
      if (audio.paused) {
        try { await audio.play(); } catch {}
      } else {
        audio.pause();
      }
      updatePlayBtn();
      el.querySelector('.music-disc')?.classList.toggle('playing', !audio.paused);
      el.querySelector('.music-cat')?.classList.toggle('walking', !audio.paused);
    }

    function onTimeUpdate() {
      if (!audio || !audio.duration) return;
      const pct = (audio.currentTime / audio.duration) * 100;
      const fill = el.querySelector('.music-progress-fill');
      if (fill) fill.style.width = `${pct}%`;
      // 小猫跟随播放进度（left 0→100%，clamp 保证不出界）
      const cat = el.querySelector('.music-cat');
      if (cat) {
        const catPct = Math.max(0, Math.min(100, pct));
        cat.style.left = `${catPct}%`;
        cat.classList.toggle('walking', !audio.paused);
      }
      const cur = el.querySelector('.music-time-cur');
      if (cur) cur.textContent = fmtTime(audio.currentTime);
    }

    function onEnded() {
      // 单曲循环直接重播当前曲目（File 重新读取，避免 audio.loop 绕过播放模式）
      if (data.loopMode === 'one') {
        playIndex(state.current);
        return;
      }
      // 自然结束：按当前模式找下一首；未开循环且已是最后一首则停下。
      const next = nextIndex(1, { auto: true });
      if (next >= 0) {
        playIndex(next);
      } else {
        updatePlayBtn();
        el.querySelector('.music-disc')?.classList.remove('playing');
        el.querySelector('.music-cat')?.classList.remove('walking');
      }
    }

    // ---- 工具 ----
    function cleanName(fileName) {
      // 去扩展名、去 "01. " 序号前缀
      return fileName.replace(/\.[^.]+$/, '').replace(/^\d+[.\s]+/, '');
    }
    function fmtTime(sec) {
      if (!isFinite(sec)) return '0:00';
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60);
      return `${m}:${String(s).padStart(2, '0')}`;
    }
    function fmtSize(n) {
      if (n == null) return '';
      return `${(n / 1024 / 1024).toFixed(1)} MB`;
    }
    function escapeHtml(s) {
      return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }
    function escapeAttr(s) { return escapeHtml(s); }

    // ---- 入口 ----
    if (!data.dirId) renderEmpty();
    else loadSongs();

    return () => {
      // 清理：停播放 + 回收 Blob URL
      if (audio) { audio.pause(); audio.src = ''; }
      if (state.blobUrl) URL.revokeObjectURL(state.blobUrl);
    };
  },
};
