// 回归测试：全量同步的清理范围（防止误删用户目录中的文件）
import test from 'node:test';
import assert from 'node:assert/strict';
import { planFolderPrune, buildExpectedFileMap } from '../extension/lib/fs.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

test('buildExpectedFileMap 只收集已知分类，并按分类分组', () => {
  const map = buildExpectedFileMap([
    { id: A, category: 'url' },
    { id: B, category: 'task_list' },
    { id: C, category: 'not_a_real_category' },
  ]);
  assert.deepEqual([...map.keys()].sort(), ['task_list', 'url']);
  assert.deepEqual([...map.get('url')], [`${A}.md`]);
  assert.deepEqual([...map.get('task_list')], [`${B}.md`]);
});

test('planFolderPrune 只删除已知分类目录中的 UUID.md', () => {
  const notes = [
    { id: A, category: 'url' },
    { id: B, category: 'task_list' },
  ];
  const existingByDir = new Map([
    // 已知分类目录：A 保留，C 过期删除；readme.md / 图片不碰
    ['url', [`${A}.md`, `${C}.md`, 'readme.md', 'cover.png']],
    // 已知分类目录：B 保留，notes.md 不是扩展命名格式，不碰
    ['task_list', [`${B}.md`, 'notes.md']],
    // 未知目录：整体不碰
    ['custom_dir', [`${C}.md`, 'manual.md']],
    // 非分类目录：整体不碰
    ['attachments', [`${C}.md`]],
  ]);

  assert.deepEqual(planFolderPrune(notes, existingByDir), [
    { dirName: 'url', fileName: `${C}.md` },
  ]);
});

test('空 notes 时只清理已知分类目录中的 UUID.md', () => {
  const existingByDir = new Map([
    ['url', [`${A}.md`, 'readme.md']],
    ['unknown', [`${A}.md`]],
  ]);
  assert.deepEqual(planFolderPrune([], existingByDir), [
    { dirName: 'url', fileName: `${A}.md` },
  ]);
});
