// 回归测试：本地 AI HTTP 探测的模型名提取与 detail 格式
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractModelInfo, extractModelNames, formatAppDetail } from '../ai_manager_host/probe.mjs';

test('OpenAI-compatible /v1/models', () => {
  assert.deepEqual(
    extractModelNames({ data: [{ id: 'qwen2.5:7b' }, { id: 'llama3.2' }] }),
    ['qwen2.5:7b', 'llama3.2'],
  );
});

test('Ollama /api/tags', () => {
  assert.deepEqual(
    extractModelNames({ models: [{ name: 'deepseek-r1:8b' }, { name: 'qwen2.5:7b' }] }),
    ['deepseek-r1:8b', 'qwen2.5:7b'],
  );
});

test('KoboldCpp /api/v1/model', () => {
  assert.deepEqual(extractModelNames({ result: 'koboldcpp/Qwen2.5-7B' }), ['koboldcpp/Qwen2.5-7B']);
});

test('模型名去重、截断，空数据安全', () => {
  assert.deepEqual(extractModelNames({ data: [{ id: 'a' }, { id: 'a' }, { id: '' }] }), ['a']);
  assert.deepEqual(extractModelNames(null), []);
  assert.deepEqual(extractModelNames({ online: true }), []);
  const long = extractModelNames([{ id: 'x'.repeat(200) }])[0];
  assert.equal(long.length, 64);
});

test('detail 拼接模型数量', () => {
  assert.equal(formatAppDetail('本地 API :11434', []), '本地 API :11434');
  assert.equal(formatAppDetail('本地 API :11434', ['qwen2.5']), '本地 API :11434 · qwen2.5');
  assert.equal(
    formatAppDetail('本地 API :11434', ['qwen2.5', 'llama3.2']),
    '本地 API :11434 · qwen2.5 等 2 个模型',
  );
  // total 超过返回的 8 个短列表时，数量仍报真实总数
  assert.equal(
    formatAppDetail('本地 API :11434', ['a', 'b'], 20),
    '本地 API :11434 · a 等 20 个模型',
  );
});

test('extractModelInfo 保留真实总数但只返回 8 个短名', () => {
  const data = { data: Array.from({ length: 20 }, (_, i) => ({ id: 'm' + i })) };
  const info = extractModelInfo(data);
  assert.equal(info.names.length, 8);
  assert.equal(info.total, 20);
  assert.deepEqual(extractModelNames(data), info.names);
});
