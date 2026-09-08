/**
 * Models.dev 模型目录前端工具：目录摘要驱动的厂商接入档案（api_format/thinking_kind
 * 由后端推导下发）、模态标签，以及目录模型条目 → 模型表单的自动填充。
 * 目录数据由后端 /api/model-adapter/catalog 代理（缓存 + 降级），此处只做纯函数。
 */

import { normalizeThinkingLevels } from './thinkingLevels.js';

export const MODEL_MODALITIES = ['text', 'image', 'audio', 'video', 'pdf'];

export const MODALITY_LABELS = {
  text: '文本',
  image: '图像',
  audio: '音频',
  video: '视频',
  pdf: 'PDF',
};

export const MODALITY_OPTIONS = MODEL_MODALITIES.map((value) => ({ value, label: MODALITY_LABELS[value] }));

/**
 * 核心 API 格式（真正的协议家族，格式下拉只列这 4 个）：
 * openai_chat 统一覆盖官方端点与 OpenAI 兼容网关，缓存行为差异由 supports_prompt_caching 表达。
 */
export const CORE_API_FORMATS = ['openai_chat', 'openai_resp', 'anthropic', 'gemini'];

export function isCoreApiFormat(apiFormat) {
  return CORE_API_FORMATS.includes(apiFormat);
}

/**
 * 目录厂商 → 接入档案：API 格式由后端 ModelsDevCatalog 从 models.dev 数据推导
 * （npm SDK 家族 / 兼容端点）并随目录摘要下发。厂商差异的表达：格式走 api_format、
 * 思考形状在模型条目 thinking_kind 上声明（目录命中模型自动预填推荐形状与值域，
 * 用户可改）、嵌套思考 map 等静态参数走 extra_params；agent-llm 只认通用形状，
 * 不出现任何厂商名。
 */
export function catalogVendorProfile(summary) {
  if (!summary?.api_format) return null;
  return { api_format: summary.api_format };
}

/** 目录厂商是否可通过现有 kernel API 格式接入（原生厂商或有兼容端点）。 */
export function isCatalogVendorConnectable(summary) {
  return catalogVendorProfile(summary) !== null;
}

export function normalizeModalities(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const result = [];
  for (const item of value) {
    const token = String(item || '').trim().toLowerCase();
    if (!MODEL_MODALITIES.includes(token) || seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

/** 目录模型 → 模型表单填充；目录缺失的字段（limit 等）保留表单当前值。 */
export function applyCatalogModel(form, catalogModel) {
  if (!catalogModel) return form;
  const next = { ...form };
  if (catalogModel.id) next.name = catalogModel.id;
  if (catalogModel.context_limit != null) next.max_context_tokens = catalogModel.context_limit;
  if (catalogModel.output_limit != null) next.max_completion_tokens = catalogModel.output_limit;
  // 目录未知 tool_call（null）时不覆盖手填的工具调用开关
  if (catalogModel.tool_call != null) next.supports_function_calling = catalogModel.tool_call === true;
  const input = normalizeModalities(catalogModel.input_modalities);
  const output = normalizeModalities(catalogModel.output_modalities);
  if (input.length) next.input_modalities = input;
  if (output.length) next.output_modalities = output;
  // 思考形状：目录有推荐值（含 reasoning:false → none）即预填（★推荐，用户可改）；
  // 无形状信息（null）保留当前选择
  if (catalogModel.recommended_thinking_kind) next.thinking_kind = catalogModel.recommended_thinking_kind;
  // 思考强度子集：目录声明 effort 值域时写入；目录明确该模型不支持思考时清空（换模型不残留）
  const efforts = normalizeThinkingLevels(catalogModel.reasoning_efforts);
  if (efforts.length) next.thinking_levels = efforts;
  else if (catalogModel.reasoning === false) next.thinking_levels = [];
  // 思考线字段声明：目录 interleaved.field（如 openrouter 部分模型的 reasoning_details），
  // 只影响思考模式的空串补齐；解析与回传按厂商原字段 round-trip，不依赖此声明
  if (catalogModel.interleaved) next.reasoning_field = catalogModel.interleaved_field === 'reasoning_details' ? 'reasoning_details' : '';
  return next;
}

/** 手输模型名时按 id/name 实时匹配目录条目（用于展示元信息）。 */
export function matchCatalogModel(catalogModels, name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target || !Array.isArray(catalogModels)) return null;
  return catalogModels.find((item) => String(item.id || '').toLowerCase() === target)
    || catalogModels.find((item) => String(item.name || '').toLowerCase() === target)
    || null;
}

function formatTokenCount(value) {
  if (value == null) return '';
  if (value >= 1000000) return `${Number((value / 1000000).toFixed(value % 1000000 === 0 ? 0 : 1))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(value % 1000 === 0 ? 0 : 1))}K`;
  return String(value);
}

function formatCost(cost) {
  if (!cost || (cost.input == null && cost.output == null)) return '';
  const input = cost.input != null ? `$${cost.input}` : '-';
  const output = cost.output != null ? `$${cost.output}` : '-';
  return `${input}/${output} 每百万 tokens`;
}

/** 目录元信息摘要：上下文/输出上限 + 定价 + 思考档位。 */
export function describeCatalogModel(catalogModel) {
  if (!catalogModel) return '';
  const parts = [];
  const context = formatTokenCount(catalogModel.context_limit);
  const output = formatTokenCount(catalogModel.output_limit);
  if (context || output) parts.push(`上下文 ${context || '?'} · 输出上限 ${output || '?'}`);
  const cost = formatCost(catalogModel.cost);
  if (cost) parts.push(cost);
  const efforts = normalizeThinkingLevels(catalogModel.reasoning_efforts);
  if (efforts.length) parts.push(`思考档位 ${efforts.join('/')}${interleavedSuffix(catalogModel)}`);
  else if (catalogModel.reasoning === true) parts.push(`深度思考${interleavedSuffix(catalogModel)}`);
  return parts.join(' · ');
}

/** 交错标记文案；目录给出线字段名（reasoning_details 方言）时一并展示。 */
function interleavedSuffix(catalogModel) {
  if (!catalogModel.interleaved) return '';
  return catalogModel.interleaved_field === 'reasoning_details' ? '（交错 · reasoning_details）' : '（交错）';
}

/** 模型条目输入模态徽标（图/音/视/P；文本是底线能力不显示）。 */
export function modelModalityMarks(entry) {
  return normalizeModalities(entry?.input_modalities)
    .filter((token) => token !== 'text')
    .map((token) => (token === 'pdf' ? 'P' : MODALITY_LABELS[token].charAt(0)));
}

/** 模型徽章 title：输入/输出模态 + 工具调用（中性词；Function Calling 是 OpenAI 方言）。 */
export function modelCapabilityTitle(model) {
  const input = normalizeModalities(model?.input_modalities);
  const output = normalizeModalities(model?.output_modalities);
  const caps = [];
  if (input.length) caps.push(`输入：${input.map((token) => MODALITY_LABELS[token]).join('、')}`);
  if (output.length) caps.push(`输出：${output.map((token) => MODALITY_LABELS[token]).join('、')}`);
  if (model?.supports_function_calling) caps.push('原生工具调用');
  const name = String(model?.name || '');
  return caps.length ? `${name}（${caps.join(' / ')}）` : name;
}
