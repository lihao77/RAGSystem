import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProviderToLlm,
  getProviderModelEntry,
  getProviderModels,
  normalizeModelList,
  parseExtraParamEntries,
  parseExtraParamsInput,
} from './modelList.js';

test('normalizeModelList trims and ignores empty model names', () => {
  assert.deepEqual(normalizeModelList([' chat ', '', null, 'reasoning']), ['chat', 'reasoning']);
  assert.deepEqual(normalizeModelList(' chat '), ['chat']);
});

test('getProviderModels 按配置顺序返回模型名并去重', () => {
  assert.deepEqual(getProviderModels({
    models: [
      { name: ' chat-model ' },
      { name: 'chat-model', temperature: 0.2 },
      { name: '', supports_vision: true },
      { name: 'chat-model-2' },
    ],
  }), ['chat-model', 'chat-model-2']);
  assert.deepEqual(getProviderModels(null), []);
  assert.deepEqual(getProviderModels({ models: 'legacy' }), []);
});

test('getProviderModelEntry 按名称取模型条目', () => {
  const provider = { models: [{ name: 'gpt-4o', temperature: 0.3, supports_vision: true }, { name: 'gpt-4o-mini' }] };
  assert.deepEqual(getProviderModelEntry(provider, ' gpt-4o '), { name: 'gpt-4o', temperature: 0.3, supports_vision: true });
  assert.equal(getProviderModelEntry(provider, 'missing'), null);
  assert.equal(getProviderModelEntry(provider, ''), null);
  assert.equal(getProviderModelEntry(null, 'gpt-4o'), null);
});

test('applyProviderToLlm 选首个模型并镜像模型条目运行参数', () => {
  assert.deepEqual(applyProviderToLlm({ temperature: 0.7, max_context_tokens: null }, {
    name: 'managed',
    provider_type: 'openai',
    models: [
      { name: 'managed-chat', temperature: 0.2, max_completion_tokens: 2048, max_context_tokens: 64000 },
      { name: 'managed-backup' },
    ],
  }), {
    provider: 'managed',
    provider_type: 'openai',
    model_name: 'managed-chat',
    temperature: 0.2,
    max_completion_tokens: 2048,
    max_context_tokens: 64000,
  });
});

test('模型条目未配置的参数保持原值', () => {
  const result = applyProviderToLlm({ temperature: 0.9, max_completion_tokens: 1024 }, {
    name: 'bare',
    provider_type: 'qwen',
    models: [{ name: 'bare-chat' }],
  });
  assert.equal(result.model_name, 'bare-chat');
  assert.equal(result.temperature, 0.9);
  assert.equal(result.max_completion_tokens, 1024);
});

test('extra LLM parameters round-trip Agent and system editor value types', () => {
  const entries = parseExtraParamEntries({
    text: 'value',
    count: 2,
    enabled: true,
    payload: { mode: 'strict' },
  });
  assert.deepEqual(parseExtraParamsInput(entries, 'LLM '), {
    text: 'value',
    count: 2,
    enabled: true,
    payload: { mode: 'strict' },
  });
  assert.throws(
    () => parseExtraParamsInput([{ key: 'enabled', type: 'boolean', value: 'yes' }], 'LLM '),
    /必须是 true 或 false/,
  );
});
