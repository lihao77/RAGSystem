import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CORE_API_FORMATS,
  applyCatalogModel,
  catalogVendorProfile,
  describeCatalogModel,
  isCatalogVendorConnectable,
  isCoreApiFormat,
  matchCatalogModel,
  modelCapabilityTitle,
  modelModalityMarks,
  normalizeModalities,
} from './modelCatalog.js';

test('PROVIDER_TYPE_CATALOG_IDS 已删除：provider_type 即厂商，格式映射单向', () => {
  // 厂商（provider_type）→ API 格式是唯一映射；类型→厂商的反向默认随字段语义合并而移除。
  assert.equal(typeof catalogVendorProfile, 'function');
});

test('CORE_API_FORMATS: 格式清单封闭为 5 种纯协议（无厂商类型）', () => {
  assert.deepEqual(CORE_API_FORMATS, ['openai_chat', 'openai_proxy', 'openai_resp', 'anthropic', 'gemini']);
  for (const format of CORE_API_FORMATS) assert.equal(isCoreApiFormat(format), true);
  // 厂商类型不再是 API 格式
  for (const format of ['mistral', 'groq', 'qwen', 'deepseek', 'openrouter', 'modelscope']) {
    assert.equal(isCoreApiFormat(format), false, `${format} 不应是 API 格式`);
  }
});

test('catalogVendorProfile: 档案 = 后端目录摘要的推导字段（无前端硬编码厂商表）', () => {
  // qwen 系（alibaba）：openai_proxy + 后端从 reasoning_options 推导的 toggle 声明
  assert.deepEqual(
    catalogVendorProfile({ id: 'alibaba', api_format: 'openai_proxy', thinking_kind: 'toggle' }),
    { api_format: 'openai_proxy', thinking_kind: 'toggle' },
  );
  // 格式默认思考形状（openai 系 effort）不带 thinking_kind
  assert.deepEqual(catalogVendorProfile({ id: 'openai', api_format: 'openai_chat', thinking_kind: null }), { api_format: 'openai_chat' });
  // 专用 SDK 厂商（bedrock/mistral 等）：无推导格式 → null 不可直连
  assert.equal(catalogVendorProfile({ id: 'mistral', api_format: null, thinking_kind: null }), null);
  assert.equal(catalogVendorProfile(null), null);
  assert.equal(isCatalogVendorConnectable({ api_format: 'openai_proxy', thinking_kind: null }), true);
  assert.equal(isCatalogVendorConnectable({ api_format: null }), false);
});

test('normalizeModalities: 过滤未知值、大小写归一、去重；非数组返回空', () => {
  assert.deepEqual(normalizeModalities(['TEXT', 'image', 'bogus', 'image']), ['text', 'image']);
  assert.deepEqual(normalizeModalities('text'), []);
  assert.deepEqual(normalizeModalities(null), []);
});

test('applyCatalogModel: 目录字段填充表单，缺失字段保留当前值', () => {
  const form = {
    name: 'manual-name',
    temperature: 0.7,
    max_completion_tokens: 4096,
    max_context_tokens: 128000,
    supports_function_calling: false,
    input_modalities: ['text'],
    output_modalities: ['text'],
  };
  const next = applyCatalogModel(form, {
    id: 'gpt-4o',
    name: 'GPT-4o',
    context_limit: 128000,
    output_limit: 16384,
    tool_call: true,
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
  });
  assert.deepEqual(next, {
    name: 'gpt-4o',
    temperature: 0.7,
    max_completion_tokens: 16384,
    max_context_tokens: 128000,
    supports_function_calling: true,
    input_modalities: ['text', 'image'],
    output_modalities: ['text'],
  });

  // 目录缺 limit/模态时不覆盖手填值
  const kept = applyCatalogModel(form, { id: 'x', name: 'X', context_limit: null, output_limit: null, input_modalities: [] });
  assert.equal(kept.max_context_tokens, 128000);
  assert.deepEqual(kept.input_modalities, ['text']);

  // 目录 tool_call 未知（null）时不覆盖手填的 FC 开关
  const fcKept = applyCatalogModel(
    { ...form, supports_function_calling: true },
    { id: 'y', name: 'Y', tool_call: null },
  );
  assert.equal(fcKept.supports_function_calling, true);

  assert.equal(applyCatalogModel(form, null), form);
});

test('applyCatalogModel: 目录 effort 值域写入思考档位子集；目录明确非思考模型清空残留', () => {
  const form = { name: '', thinking_levels: ['low', 'medium'] };
  const next = applyCatalogModel(form, {
    id: 'deepseek-v3.1',
    reasoning: true,
    reasoning_efforts: ['max', 'low', 'high', 'bogus'],
  });
  assert.deepEqual(next.thinking_levels, ['low', 'high', 'max']);

  // 目录未声明 effort 值域（如 qwen 纯 toggle）：不覆盖手填值
  const untouched = applyCatalogModel({ ...form }, { id: 'qwen3-max', reasoning: true, reasoning_efforts: [] });
  assert.deepEqual(untouched.thinking_levels, ['low', 'medium']);

  // 目录明确 reasoning:false（非思考模型）：清空旧子集，换模型不残留
  const cleared = applyCatalogModel({ ...form }, { id: 'gpt-4o-mini', reasoning: false, reasoning_efforts: [] });
  assert.deepEqual(cleared.thinking_levels, []);
});

test('applyCatalogModel: interleaved.field 声明思考线方言；bool 标记/无标记不动声明', () => {
  // openrouter reasoning_details 方言
  const details = applyCatalogModel({ name: '' }, { id: 'grok-4', interleaved: true, interleaved_field: 'reasoning_details' });
  assert.equal(details.reasoning_field, 'reasoning_details');
  // reasoning_content 方言 → 空串（= 缺省补齐字段）
  const content = applyCatalogModel({ name: '', reasoning_field: 'reasoning_details' }, { id: 'deepseek-v3.1', interleaved: true, interleaved_field: 'reasoning_content' });
  assert.equal(content.reasoning_field, '');
  // 无 interleaved 标记：不写声明（手配值不受影响）
  const untouched = applyCatalogModel({ name: '', reasoning_field: 'reasoning_details' }, { id: 'plain-model' });
  assert.equal(untouched.reasoning_field, 'reasoning_details');
});

test('matchCatalogModel: 按 id/name 忽略大小写匹配', () => {
  const models = [{ id: 'gpt-4o', name: 'GPT-4o' }, { id: 'glm-5', name: 'GLM 5' }];
  assert.equal(matchCatalogModel(models, ' GPT-4O ').id, 'gpt-4o');
  assert.equal(matchCatalogModel(models, 'glm 5').id, 'glm-5');
  assert.equal(matchCatalogModel(models, ''), null);
  assert.equal(matchCatalogModel(null, 'gpt-4o'), null);
});

test('describeCatalogModel: 上下文/输出上限、定价与思考档位摘要', () => {
  assert.equal(
    describeCatalogModel({ context_limit: 128000, output_limit: 16384, cost: { input: 2.5, output: 10 } }),
    '上下文 128K · 输出上限 16.4K · $2.5/$10 每百万 tokens',
  );
  assert.equal(describeCatalogModel({ context_limit: 1000000 }), '上下文 1M · 输出上限 ?');
  assert.equal(describeCatalogModel({}), '');
  assert.equal(describeCatalogModel(null), '');
  // effort 值域 + 交错标记（reasoning_details 方言附字段名）
  assert.equal(
    describeCatalogModel({ reasoning: true, reasoning_efforts: ['low', 'high', 'max'], interleaved: true, interleaved_field: 'reasoning_details' }),
    '思考档位 low/high/max（交错 · reasoning_details）',
  );
  // 目录只标 reasoning 无 effort 枚举（如纯 toggle 厂商）
  assert.equal(describeCatalogModel({ reasoning: true, reasoning_efforts: [] }), '深度思考');
  assert.equal(describeCatalogModel({ reasoning: true, reasoning_efforts: [], interleaved: true }), '深度思考（交错）');
});

test('modelModalityMarks: 图/音/视/P 标记，文本不显示', () => {
  assert.deepEqual(modelModalityMarks({ input_modalities: ['text', 'image', 'audio', 'video', 'pdf'] }), ['图', '音', '视', 'P']);
  assert.deepEqual(modelModalityMarks({ input_modalities: ['text'] }), []);
  assert.deepEqual(modelModalityMarks({}), []);
});

test('modelCapabilityTitle: 输入/输出模态 + 原生工具调用（中性词，不用 OpenAI 的 Function Calling）', () => {
  assert.equal(
    modelCapabilityTitle({ name: 'gpt-4o', input_modalities: ['text', 'image'], output_modalities: ['text'], supports_function_calling: true }),
    'gpt-4o（输入：文本、图像 / 输出：文本 / 原生工具调用）',
  );
  assert.equal(modelCapabilityTitle({ name: 'm' }), 'm');
});
