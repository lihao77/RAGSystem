import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyProviderToLlm,
  getProviderModels,
  normalizeModelList,
  parseExtraParamEntries,
  parseExtraParamsInput,
} from './modelList.js';

test('normalizeModelList trims and ignores empty model names', () => {
  assert.deepEqual(normalizeModelList([' chat ', '', null, 'reasoning']), ['chat', 'reasoning']);
  assert.deepEqual(normalizeModelList(' chat '), ['chat']);
});

test('getProviderModels follows chat-first model map order and deduplicates legacy fields', () => {
  assert.deepEqual(getProviderModels({
    model_map: {
      embedding: ['embed-1', 'chat-model'],
      chat: [' chat-model ', 'chat-model-2'],
      rerank: 'rerank-1',
    },
    models: ['chat-model-2', 'legacy-model'],
    model: 'legacy-model-2',
  }), ['chat-model', 'chat-model-2', 'embed-1', 'rerank-1', 'legacy-model', 'legacy-model-2']);
});

test('applyProviderToLlm mirrors provider-managed model parameters', () => {
  assert.deepEqual(applyProviderToLlm({ temperature: 0.7, max_context_tokens: null }, {
    name: 'managed',
    provider_type: 'openai',
    model_map: { chat: 'managed-chat' },
    temperature: 0.2,
    max_completion_tokens: 2048,
    max_context_tokens: 64000,
  }), {
    provider: 'managed',
    provider_type: 'openai',
    model_name: 'managed-chat',
    temperature: 0.2,
    max_completion_tokens: 2048,
    max_context_tokens: 64000,
  });
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
