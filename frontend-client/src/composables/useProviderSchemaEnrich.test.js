import test from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useProviderSchemaEnrich } from './useProviderSchemaEnrich.js';

const providerSchema = (key, fields, extra = {}) => ({ key, fields, ...extra });

function setup(providers = []) {
  const providersRef = ref(providers);
  return { providersRef, ...useProviderSchemaEnrich(providersRef) };
}

test('enrich:provider/model 字段动态化为下拉，provider_type 禁用', () => {
  const { enrichSchemaWithProviderSelection } = setup([
    { name: 'openai', key: 'openai', provider_type: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] },
  ]);
  const schema = {
    groups: [providerSchema('llm', [
      { key: 'provider', type: 'string' },
      { key: 'provider_type', type: 'string' },
      { key: 'model_name', type: 'string' },
    ], { providerSelect: { autoSelectModel: true, applyProviderFields: ['temperature'] } })],
  };
  const config = { llm: { provider: 'openai', provider_type: 'openai', model_name: 'gpt-4o' } };

  const next = enrichSchemaWithProviderSelection(schema, config);
  const fields = next.groups[0].fields;
  const providerField = fields.find((f) => f.key === 'provider');
  const modelField = fields.find((f) => f.key === 'model_name');
  const typeField = fields.find((f) => f.key === 'provider_type');

  assert.equal(providerField.type, 'select');
  assert.deepEqual(providerField.options.map((o) => o.value), ['', 'openai']);
  assert.equal(modelField.type, 'select');
  assert.deepEqual(modelField.options.map((o) => o.value), ['', 'gpt-4o', 'gpt-4o-mini']);
  assert.equal(typeField.disabled, true);
  assert.equal(typeField.help, '由所选 Provider 自动带出');
  // 原对象不被修改
  assert.equal(schema.groups[0].fields[0].type, 'string');
});

test('enrich:visionOnly 提示只列支持视觉的 provider，与组名无关', () => {
  const { enrichSchemaWithProviderSelection } = setup([
    { name: 'openai', supports_vision: true },
    { name: 'text-only', supports_vision: false },
  ]);
  const schema = {
    groups: [providerSchema('ocr_helper', [
      { key: 'provider', type: 'string' },
      { key: 'model_name', type: 'string' },
    ], { providerSelect: { visionOnly: true } })],
  };
  const config = { ocr_helper: { provider: 'legacy-vendor', model_name: 'old-model' } };

  const next = enrichSchemaWithProviderSelection(schema, config);
  const providerField = next.groups[0].fields.find((f) => f.key === 'provider');
  const modelField = next.groups[0].fields.find((f) => f.key === 'model_name');

  assert.deepEqual(providerField.options.map((o) => o.value), ['', 'legacy-vendor', 'openai']);
  assert.deepEqual(modelField.options.map((o) => o.value), ['', 'old-model']);
});

test('enrich:未声明 visionOnly 时列出全部 provider', () => {
  const { enrichSchemaWithProviderSelection } = setup([
    { name: 'openai', supports_vision: true },
    { name: 'text-only', supports_vision: false },
  ]);
  const schema = {
    groups: [providerSchema('llm', [{ key: 'provider', type: 'string' }, { key: 'model_name', type: 'string' }])],
  };
  const config = { llm: { provider: 'openai', model_name: 'm1' } };

  const next = enrichSchemaWithProviderSelection(schema, config);
  const providerField = next.groups[0].fields.find((f) => f.key === 'provider');
  assert.deepEqual(providerField.options.map((o) => o.value), ['', 'openai', 'text-only']);
});

test('enrich:无 provider/model 字段的组与无配置值的组原样跳过', () => {
  const { enrichSchemaWithProviderSelection } = setup([{ name: 'openai' }]);
  const schema = {
    groups: [
      providerSchema('pet', [{ key: 'default_animation', type: 'string' }]),
      providerSchema('llm', [{ key: 'provider', type: 'string' }]),
    ],
  };

  const next = enrichSchemaWithProviderSelection(schema, { pet: { default_animation: 'idle' } });
  assert.equal(next.groups[0].fields[0].type, 'string');
  assert.equal(next.groups[1].fields[0].type, 'string');
});

test('cascade:autoSelectModel 提示切换 provider 自动选第一个模型并回填 applyProviderFields', () => {
  const { applyProviderCascade } = setup([
    { name: 'openai', provider_type: 'openai', models: ['gpt-4o', 'gpt-4o-mini'], temperature: 0.3, max_context_tokens: 200000 },
  ]);
  const schema = {
    groups: [providerSchema('llm', [
      { key: 'provider' },
      { key: 'provider_type' },
      { key: 'model_name' },
    ], { providerSelect: { autoSelectModel: true, applyProviderFields: ['temperature', 'max_completion_tokens', 'max_context_tokens'] } })],
  };
  const prev = { llm: { provider: '', provider_type: '', model_name: '', temperature: 0.7 } };
  const next = { llm: { provider: 'openai', provider_type: '', model_name: '', temperature: 0.7 } };

  const result = applyProviderCascade(prev, next, schema);
  assert.equal(result.llm.provider, 'openai');
  assert.equal(result.llm.provider_type, 'openai');
  assert.equal(result.llm.model_name, 'gpt-4o');
  assert.equal(result.llm.temperature, 0.3);
  assert.equal(result.llm.max_context_tokens, 200000);
  // Provider 未提供的字段保持原值
  assert.equal(result.llm.max_completion_tokens, undefined);
});

test('cascade:未声明 autoSelectModel 的组切换 provider 时清空 model_name', () => {
  const { applyProviderCascade } = setup([
    { name: 'openai', key: 'openai', provider_type: 'openai', models: ['gpt-4o'] },
  ]);
  const schema = {
    groups: [providerSchema('vision_helper', [
      { key: 'provider' },
      { key: 'model_name' },
    ], { providerSelect: { visionOnly: true } })],
  };
  const prev = { vision_helper: { provider: 'legacy-vendor', provider_type: 'other', model_name: 'old-model' }, pet: { scale: 1 } };
  const next = { vision_helper: { provider: 'openai', provider_type: 'other', model_name: 'old-model' }, pet: { scale: 1 } };

  const result = applyProviderCascade(prev, next, schema);
  assert.deepEqual(result.vision_helper, { provider: 'openai', provider_type: 'openai', model_name: '' });
  // 非 provider 组原样透传，不被写入 provider 相关字段
  assert.deepEqual(result.pet, { scale: 1 });
});

test('cascade:清空 provider 重置关联字段', () => {
  const { applyProviderCascade } = setup([{ name: 'openai' }]);
  const schema = {
    groups: [providerSchema('image_tools', [{ key: 'provider' }, { key: 'model_name' }])],
  };
  const prev = { image_tools: { provider: 'openai', provider_type: 'openai', model_name: 'm1' } };
  const next = { image_tools: { provider: '', provider_type: 'openai', model_name: 'm1' } };

  const result = applyProviderCascade(prev, next, schema);
  assert.deepEqual(result.image_tools, { provider: '', provider_type: '', model_name: '' });
});

test('cascade:provider 未变化时不改写该组', () => {
  const { applyProviderCascade } = setup([{ name: 'openai', provider_type: 'openai' }]);
  const schema = {
    groups: [providerSchema('image_tools', [{ key: 'provider' }, { key: 'model_name' }])],
  };
  const prev = { image_tools: { provider: 'openai', model_name: 'm1' } };
  const next = { image_tools: { provider: 'openai', model_name: 'm2' } };

  const result = applyProviderCascade(prev, next, schema);
  assert.equal(result.image_tools.model_name, 'm2');
});
