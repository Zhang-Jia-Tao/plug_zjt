// widgets/promptVault.js — Prompt / Snippet 速取
// 完全本地：内容存 widget.data.items，点击复制，不发送到任何服务。

export const DEFAULT_ITEMS = [
  {
    id: 'seed-review',
    title: '代码审查',
    tag: 'Review',
    body: '请以资深全栈工程师的视角审查这段代码：先列出会导致线上故障的问题，再给出最小修复方案；重点关注边界条件、并发、错误处理、SQL 注入、鉴权和可观测性。最后用表格输出“问题 / 影响 / 修复”。',
  },
  {
    id: 'seed-debug',
    title: '报错定位',
    tag: 'Debug',
    body: '下面是一段报错和相关代码。请不要直接猜结论：先按“复现条件 → 调用链 → 根因假设 → 验证命令”分析，再给修复补丁；如果信息不足，明确列出还需要哪些日志或上下文。',
  },
  {
    id: 'seed-test',
    title: '补单测',
    tag: 'Test',
    body: '为这段逻辑补充单元测试，覆盖正常路径、空值、边界值、异常分支和并发/幂等场景。使用项目现有测试框架，不要引入新依赖；先给测试用例清单，再给可运行代码。',
  },
  {
    id: 'seed-sql',
    title: '优化 SQL',
    tag: 'SQL',
    body: '分析这条 SQL 的执行计划与索引使用情况，指出全表扫描、回表、排序和锁竞争风险；给出改写方案，并说明在数据量增长 10 倍时是否仍然成立。',
  },
  {
    id: 'seed-commit',
    title: '提交信息',
    tag: 'Git',
    body: '根据以下 diff 生成 Conventional Commits 提交信息：第一行不超过 72 字符，正文说明动机、行为和风险；不要编造未出现的改动。',
  },
];

function uid() {
  try { return crypto.randomUUID(); } catch { return `p-${Date.now()}-${Math.random().toString(16).slice(2)}`; }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[ch]);
}

function normalizeItems(value) {
  if (!Array.isArray(value)) return structuredClone(DEFAULT_ITEMS);
  return value
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: String(item.id || uid()),
      title: String(item.title || '未命名').slice(0, 80),
      tag: String(item.tag || 'Prompt').slice(0, 24),
      body: String(item.body || '').slice(0, 8000),
    }));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

export default {
  key: 'promptVault',
  label: 'Prompt 速取',
  description: '常用 Prompt、代码片段与命令，一键复制到剪贴板',
  defaultData: { items: DEFAULT_ITEMS },
  config: [],

  init(container, data, api) {
    const el = document.createElement('div');
    el.className = 'mini-widget pv-widget';
    el.innerHTML = `
      <div class="mini-head">
        <span class="mini-icon pv-icon" aria-hidden="true">✎</span>
        <div class="mini-copy">
          <div class="mini-title">Prompt 速取</div>
          <div class="mini-sub">点击条目复制 · 本地保存</div>
        </div>
        <div class="mini-actions">
          <button type="button" class="mini-iconbtn pv-add" title="新增 Prompt" aria-label="新增 Prompt">＋</button>
        </div>
      </div>
      <div class="pv-body"></div>
    `;
    container.appendChild(el);

    const bodyEl = el.querySelector('.pv-body');
    const subEl = el.querySelector('.mini-sub');
    const addBtn = el.querySelector('.pv-add');
    let items = normalizeItems(data.items);
    let editingId = null;
    let toastTimer = 0;
    let destroyed = false;

    function save() {
      if (destroyed) return;
      api.patchWidget({ items });
    }

    function setSub(text, title = '') {
      subEl.textContent = text;
      subEl.title = title;
    }

    function renderList() {
      editingId = null;
      bodyEl.innerHTML = '';
      if (!items.length) {
        const empty = document.createElement('div');
        empty.className = 'mini-state';
        empty.textContent = '还没有 Prompt\n点击右上角 ＋ 新建';
        bodyEl.appendChild(empty);
        setSub('0 条 · 本地保存');
        return;
      }
      const list = document.createElement('div');
      list.className = 'mini-list pv-list';
      list.innerHTML = items.map((item) => `
        <div class="mini-row pv-row" data-id="${escapeHtml(item.id)}">
          <span class="pv-tag">${escapeHtml(item.tag)}</span>
          <span class="pv-title" title="${escapeHtml(item.body)}">${escapeHtml(item.title)}</span>
          <button type="button" class="pv-action pv-copy" title="复制" aria-label="复制 ${escapeHtml(item.title)}">⧉</button>
          <button type="button" class="pv-action pv-edit" title="编辑" aria-label="编辑 ${escapeHtml(item.title)}">✎</button>
          <button type="button" class="pv-action pv-del" title="删除" aria-label="删除 ${escapeHtml(item.title)}">×</button>
        </div>
      `).join('');
      bodyEl.appendChild(list);
      setSub(`${items.length} 条 · 本地保存`);

      list.addEventListener('click', (event) => {
        const row = event.target.closest('.pv-row');
        if (!row) return;
        const item = items.find((it) => it.id === row.dataset.id);
        if (!item) return;
        if (event.target.closest('.pv-edit')) {
          openForm(item);
          return;
        }
        if (event.target.closest('.pv-del')) {
          if (!confirm(`删除「${item.title}」？`)) return;
          items = items.filter((it) => it.id !== item.id);
          save();
          renderList();
          return;
        }
        doCopy(item, row);
      });
    }

    async function doCopy(item, row) {
      const ok = await copyText(item.body);
      if (destroyed) return;
      if (!ok) {
        setSub('复制失败，请手动打开编辑框复制');
        return;
      }
      row.classList.add('copied');
      setSub(`已复制 · ${item.title}`, item.body);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        if (destroyed) return;
        row.classList.remove('copied');
        setSub(`${items.length} 条 · 本地保存`);
      }, 1400);
    }

    function openForm(item = null) {
      editingId = item?.id || null;
      const current = item || { title: '', tag: 'Prompt', body: '' };
      bodyEl.innerHTML = `
        <form class="mini-form pv-form">
          <div class="mini-form-row">
            <input class="mini-input pv-title-input" name="title" maxlength="80"
              placeholder="标题，例如：代码审查" value="${escapeHtml(current.title)}" autocomplete="off" />
            <input class="mini-input pv-tag-input" name="tag" maxlength="24"
              placeholder="标签" value="${escapeHtml(current.tag)}" autocomplete="off" />
          </div>
          <textarea class="mini-textarea pv-body-input" name="body" maxlength="8000"
            placeholder="Prompt / 代码片段 / 命令…">${escapeHtml(current.body)}</textarea>
          <div class="pv-form-actions">
            <button type="button" class="mini-btn pv-cancel">取消</button>
            <button type="submit" class="mini-btn mini-btn-primary">${editingId ? '保存修改' : '保存'}</button>
          </div>
          <div class="mini-hint">内容只存本机浏览器，不会上传。</div>
        </form>
      `;
      const form = bodyEl.querySelector('.pv-form');
      const titleInput = form.querySelector('.pv-title-input');
      const tagInput = form.querySelector('.pv-tag-input');
      const bodyInput = form.querySelector('.pv-body-input');
      titleInput.focus();
      setSub(editingId ? '编辑 Prompt' : '新增 Prompt');
      form.querySelector('.pv-cancel').addEventListener('click', renderList);
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const title = titleInput.value.trim();
        const text = bodyInput.value.trim();
        if (!title || !text) {
          setSub('标题和内容不能为空');
          (!title ? titleInput : bodyInput).focus();
          return;
        }
        const tag = tagInput.value.trim() || 'Prompt';
        if (editingId) {
          items = items.map((it) => it.id === editingId ? { ...it, title, tag, body: text } : it);
        } else {
          items = [{ id: uid(), title, tag, body: text }, ...items];
        }
        save();
        renderList();
      });
    }

    addBtn.addEventListener('click', () => openForm());
    setSub(`${items.length} 条 · 本地保存`);
    renderList();

    return () => {
      destroyed = true;
      clearTimeout(toastTimer);
    };
  },
};
