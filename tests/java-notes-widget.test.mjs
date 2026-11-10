// Java 笔记学习台：数据归一化 + host/扩展接线回归
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeLearning,
  classifyState,
  stripAnsi,
  normalizeProjectRoot,
  inspectProjectRoot,
  discoverJavaNotesRoots,
  resolveJavaNotesRoot,
  JavaNotesProject,
  DEFAULT_PROJECT_ROOT,
  ProjectError,
} from '../ai_manager_host/project-supervisor.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('学习数据归一化：今日复习、学习位置、批注数', () => {
  const now = new Date();
  now.setHours(12, 0, 0, 0);
  const today = now.getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  const usage = {
    modules: {
      project: {
        visits: 3,
        ms: 120000,
        paths: {
          '/project/source': { visits: 2, ms: 120000, lastAt: today - 1000 },
          '/project': { visits: 1, ms: 0, lastAt: yesterday },
        },
      },
      home: { visits: 2, ms: 60000, paths: { '/': { visits: 2, ms: 60000, lastAt: today - 2000 } } },
    },
    updatedAt: today,
  };
  const review = {
    items: {
      a: { at: today, ok: true },
      b: { at: today, ok: true },
      c: { at: yesterday, ok: true },
      d: { at: today, ok: false },
    },
    updatedAt: today,
  };
  const annos = {
    pages: {
      '/a': [{ id: '1' }, { id: '2' }],
      '/b': [{ id: '3' }],
      '/empty': [],
    },
    updatedAt: today,
  };
  const out = normalizeLearning({ usage, review, annos, now: today });
  assert.equal(out.todayReview, 2);
  assert.equal(out.reviewTotal, 3);
  assert.equal(out.annotations, 3);
  assert.equal(out.annotationPages, 2);
  assert.equal(out.usageMinutes, 3);
  assert.equal(out.totalVisits, 5);
  assert.equal(out.lastPath, '/project/source');
  assert.equal(out.updatedAt, today);
});

test('状态分类：停止 / 部分运行 / 完整运行 / 端口冲突', () => {
  assert.equal(classifyState({
    busy: false, phase: 'idle',
    site: { ok: false, foreign: false }, anno: { ok: false }, lastError: null,
  }), 'stopped');
  assert.equal(classifyState({
    busy: false, phase: 'idle',
    site: { ok: true, foreign: false }, anno: { ok: false }, lastError: null,
  }), 'running_site_only');
  assert.equal(classifyState({
    busy: false, phase: 'idle',
    site: { ok: true, foreign: false }, anno: { ok: true }, lastError: null,
  }), 'running_full');
  assert.equal(classifyState({
    busy: false, phase: 'idle',
    site: { ok: true, foreign: true }, anno: { ok: false }, lastError: null,
  }), 'port_conflict');
  assert.equal(classifyState({
    busy: true, phase: 'starting', site: { ok: false }, anno: { ok: false }, lastError: null,
  }), 'starting');
});

test('启动目录归一化：默认、绝对路径、引号、环境变量与非法相对路径', () => {
  const target = path.resolve(process.cwd(), 'code', 'Java终极笔记');
  const envRoot = path.resolve(process.cwd(), 'work');
  assert.equal(normalizeProjectRoot('', { defaultRoot: DEFAULT_PROJECT_ROOT }), path.resolve(DEFAULT_PROJECT_ROOT));
  assert.equal(
    normalizeProjectRoot(`  "${target}"  `, { defaultRoot: DEFAULT_PROJECT_ROOT }),
    target,
  );
  assert.equal(
    normalizeProjectRoot('%TEST_JN_ROOT%/notes', {
      defaultRoot: DEFAULT_PROJECT_ROOT,
      env: { ...process.env, TEST_JN_ROOT: envRoot },
    }),
    path.join(envRoot, 'notes'),
  );
  assert.throws(
    () => normalizeProjectRoot('relative/notes', { defaultRoot: DEFAULT_PROJECT_ROOT }),
    (e) => e instanceof ProjectError && e.code === 'invalid_root',
  );
});

test('项目目录校验与自动探测：显式目录、备用目录、JAVA_NOTES_ROOT', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jn-root-'));
  const home = path.join(tmp, 'home');
  const projects = path.join(home, 'IdeaProjects');
  const defaultRoot = path.join(projects, 'Java终极笔记');
  const alternate = path.join(projects, 'Java备用笔记');
  const makeProject = (root) => {
    fs.mkdirSync(path.join(root, 'site'), { recursive: true });
    fs.writeFileSync(path.join(root, 'start.ps1'), '# test\n');
    fs.writeFileSync(path.join(root, 'site', 'package.json'), '{}\n');
  };
  try {
    fs.mkdirSync(projects, { recursive: true });
    makeProject(alternate);
    const good = inspectProjectRoot(alternate);
    assert.equal(good.valid, true);
    assert.deepEqual(good.missing, []);

    const partial = path.join(tmp, 'partial');
    fs.mkdirSync(path.join(partial, 'site'), { recursive: true });
    const bad = inspectProjectRoot(partial);
    assert.equal(bad.valid, false);
    assert.ok(bad.missing.includes('start.ps1'));

    // 显式目录有效时不被环境变量/默认目录抢走。
    const direct = resolveJavaNotesRoot(alternate, {
      defaultRoot,
      env: { ...process.env, JAVA_NOTES_ROOT: alternate, USERPROFILE: home },
      searchRoots: [],
    });
    assert.equal(direct.root, alternate);
    assert.equal(direct.source, 'configured');
    assert.equal(direct.requestedRoot, alternate);

    // 旧机器的目录失效：允许自动改用同一用户目录下检测到的项目。
    const fallback = resolveJavaNotesRoot(path.join(tmp, 'old-host'), {
      defaultRoot,
      env: { ...process.env, USERPROFILE: home },
      autoFallback: true,
      searchRoots: [projects],
    });
    assert.equal(fallback.root, alternate);
    assert.equal(fallback.source, 'fallback');
    assert.match(fallback.warning, /自动改用/);
    assert.equal(fallback.requestedRoot, path.join(tmp, 'old-host'));

    const project = new JavaNotesProject({ ...fallback });
    try {
      const snapshot = project.getSnapshot();
      assert.equal(snapshot.root, alternate);
      assert.equal(snapshot.requestedRoot, path.join(tmp, 'old-host'));
      assert.equal(snapshot.rootSource, 'fallback');
      assert.equal(snapshot.rootChecks.valid, true);
      assert.match(snapshot.rootWarning, /自动改用/);
    } finally {
      project.dispose();
    }

    // 关闭自动备用时保留原始错误，不偷偷换目录。
    assert.throws(
      () => resolveJavaNotesRoot(path.join(tmp, 'old-host'), {
        defaultRoot,
        env: { ...process.env, USERPROFILE: home },
        autoFallback: false,
        searchRoots: [projects],
      }),
      (e) => e instanceof ProjectError && e.code === 'project_missing' && /可用目录/.test(e.detail),
    );

    // 留空：JAVA_NOTES_ROOT 优先于默认目录。
    const envRoot = resolveJavaNotesRoot('', {
      defaultRoot,
      env: { ...process.env, JAVA_NOTES_ROOT: alternate, USERPROFILE: home },
      searchRoots: [],
    });
    assert.equal(envRoot.root, alternate);
    assert.equal(envRoot.source, 'env');
    assert.equal(envRoot.requestedRoot, '');

    // 留空且默认目录不存在：在 IdeaProjects 下浅扫描到项目。
    const auto = resolveJavaNotesRoot('', {
      defaultRoot,
      env: { ...process.env, USERPROFILE: home, JAVA_NOTES_ROOT: '' },
      searchRoots: [projects],
    });
    assert.equal(auto.root, alternate);
    assert.equal(auto.source, 'auto');
    assert.match(auto.warning, /自动检测/);

    const candidates = discoverJavaNotesRoots({
      defaultRoot,
      env: { ...process.env, USERPROFILE: home },
      searchRoots: [projects],
    });
    assert.ok(candidates.some((c) => c.root === alternate && c.valid));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('日志去掉 ANSI 控制序列且保留中文', () => {
  const raw = '\u001b[32m✓ 站点就绪\u001b[0m\r\n\u001b[2m16:38\u001b[22m /project';
  const clean = stripAnsi(raw);
  assert.ok(clean.includes('✓ 站点就绪'));
  assert.ok(clean.includes('/project'));
  assert.ok(!clean.includes('\u001b'));
  assert.ok(!clean.includes('\r'));
});

test('host 注册项目监管并暴露快照/命令', () => {
  const host = fs.readFileSync(path.join(root, 'ai_manager_host/host.mjs'), 'utf8');
  assert.match(host, /import \{[^}]*JavaNotesProject[^}]*\} from '\.\/project-supervisor\.mjs'/);
  assert.match(host, /javaNotes: javaNotes \? javaNotes\.getSnapshot\(\) : null/);
  assert.match(host, /case 'project:watch'/);
  assert.match(host, /case 'project:command'/);
  assert.match(host, /new JavaNotesProject\(/);
  assert.match(host, /switchJavaNotesRoot/);
  assert.match(host, /resolveJavaNotesRoot/);
});

test('扩展接线：widget 注册、默认布局、命令转发', () => {
  const registry = fs.readFileSync(path.join(root, 'newtab/js/widgets/registry.js'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'newtab/js/store.js'), 'utf8');
  const background = fs.readFileSync(path.join(root, 'newtab/background.js'), 'utf8');
  const supervisor = fs.readFileSync(path.join(root, 'ai_manager_host/project-supervisor.mjs'), 'utf8');
  assert.match(registry, /javaNotes/);
  assert.match(registry, /githubRanking/);
  assert.match(store, /key: 'javaNotes'/);
  assert.match(store, /SCHEMA_VERSION = 12/);
  assert.match(background, /forwardProjectCommand/);
  assert.match(background, /type: 'project:command'/);
  assert.match(background, /forwardProjectMessage/);
  assert.match(background, /projectWaiters/);
  assert.match(background, /settleProjectWaiter/);
  assert.ok(fs.existsSync(path.join(root, 'newtab/js/widgets/javaNotes.js')));
  assert.ok(fs.existsSync(path.join(root, 'newtab/css/widgets.css')));
  const widget = fs.readFileSync(path.join(root, 'newtab/js/widgets/javaNotes.js'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'newtab/js/main.js'), 'utf8');
  assert.match(widget, /key: 'root'[\s\S]*?type: 'text'/);
  assert.match(widget, /root: projectRoot/);
  assert.match(widget, /autoFallback/);
  assert.match(widget, /chrome\.runtime\.sendMessage\(\{[\s\S]{0,200}action: 'project:command'/);
  assert.match(widget, /正在请求 host 启动/);
  assert.match(widget, /port_conflict'\) return \{ label: '端口被占用'[\s\S]{0,80}disabled: false/);
  assert.match(main, /c\.type === 'text'/);
  assert.match(background, /projectAutoFallback/);
  assert.match(supervisor, /start\.log/);
  assert.match(supervisor, /START_TIMEOUT_MS = 300_000/);
  assert.match(supervisor, /rootSource/);
});
