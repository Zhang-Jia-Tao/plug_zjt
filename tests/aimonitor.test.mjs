// 回归测试：AI 管理器的「显示/收起离线应用」在全部筛选下也要生效
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAiItems } from '../newtab/js/ai-filter.js';

const items = [
  { key: 'local:claude-code', source: 'local', status: 'tasking' },
  { key: 'local:ollama', source: 'local', status: 'online' },
  { key: 'local:lmstudio', source: 'local', status: 'offline' },
  { key: 'web:chatgpt', source: 'web', status: 'online' },
  { key: 'web:deepseek', source: 'web', status: 'offline' },
];

test('全部筛选默认隐藏离线，展开后显示离线', () => {
  assert.deepEqual(
    filterAiItems(items, 'all', false).map(i => i.key),
    ['local:claude-code', 'local:ollama', 'web:chatgpt'],
  );
  assert.deepEqual(
    filterAiItems(items, 'all', true).map(i => i.key),
    ['local:claude-code', 'local:ollama', 'local:lmstudio', 'web:chatgpt', 'web:deepseek'],
  );
});

test('本机筛选同样响应离线展开', () => {
  assert.deepEqual(
    filterAiItems(items, 'local', false).map(i => i.key),
    ['local:claude-code', 'local:ollama'],
  );
  assert.deepEqual(
    filterAiItems(items, 'local', true).map(i => i.key),
    ['local:claude-code', 'local:ollama', 'local:lmstudio'],
  );
});

test('网页筛选不受本机离线开关影响', () => {
  assert.deepEqual(
    filterAiItems(items, 'web', true).map(i => i.key),
    ['web:chatgpt', 'web:deepseek'],
  );
});
