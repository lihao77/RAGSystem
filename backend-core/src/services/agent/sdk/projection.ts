import { asRecord, normalizeString } from "../../../utils/guards.js";

/**
 * 投影层（设计稿 §3）—— AgentConfig → AgentProfile 的唯一解析点。
 *
 * 投影算死五件事（内核零兜底，只读 profile.llmTiers）：
 *   1. provider 引用解析：tier.provider/provider_type → findProviderByRef 内联完整 ProviderConfig
 *   2. selectLlm 替换 default：前端选定的 provider+model 整体替换 default 档
 *   3. 字段回落：场景 tier → default 逐级 ??（两级，无 system 第三级）
 *   4. extra_params merge：provider extra_params + tier extra_params（tier 覆盖 provider 同名 key）
 *   5. maxContextTokens 解析：tier → provider.max_context_tokens
 *
 * default 档失效回落：agent default 档引用解析不到（悬空 provider、模型下架、半空
 * 残壳）时，若调用方携带 systemLlm 且其可解析，则 default 位置整体回落系统 LLM
 * （与 runtime-core 的「配置失效即回落」策略同判定 providerRefResolves、同口径）。
 * 回落只发生在投影层，SDK 内核仍零兜底、只读 profile.llmTiers。
 *
 * 与 backend-ts 旧 resolveTierLlmParams 的差异：
 *   - selectLlm 替换 default 已在此处做完，resolved.tiers.default 永远是最终真相，
 *     readTierParams 只做两级回落
 */
import type { AgentProfile, ResolvedTier, TierMap } from "@ragsystem/agent-sdk";
import { ALL_THINKING_LEVELS, type ProviderConfig, type ThinkingLevel } from "@ragsystem/agent-llm";
import type { AgentConfig, AgentLlmConfig } from "../../../contracts/agent/agent-config.js";
import type { ModelProviderConfig, ProviderModelEntry } from "../../../contracts/integrations/model-adapter.js";
import { findProviderByRef, providerRefResolves } from "../../runtime/provider-lookup.js";
import { compactRecord } from "../llm-params.js";

export interface ProjectionInput {
  agent: AgentConfig;
  /** 已加载的全部 provider，用于 tier.provider 引用解析。 */
  providers: ModelProviderConfig[];
  /**
   * 前端 selectLlm 解析结果（optional）：整体替换 default 档。
   * 指向 input.providers 中的某一条 provider + 其 models 中的一个模型。
   */
  selectedLlm?: {
    provider: ModelProviderConfig;
    modelName: string;
  } | null;
  /**
   * 系统 LLM 兜底（optional，AgentLlmConfig 同构形态）：agent default 档引用
   * 解析不到时回落为 default 档。不传 = 本调用方不参与兜底（preview 等不调
   * LLM 的场景保持 default 可缺）。
   */
  systemLlm?: AgentLlmConfig | null;
  /**
   * 请求级思考档位（前端 thinking_level 透传）；优先于 tier 默认档位。
   * undefined = 用 agent tier 配置的默认档位。
   */
  thinkingLevel?: ThinkingLevel;
}

/**
 * 投影 AgentConfig → AgentProfile。
 *
 * default 档可缺（provider 未配时返回无 default 的 profile）—— preview 不调 LLM、不需 tier；
 * run 用 profile 由 createRuntime.run 守卫 default 必填。调试 snapshot 在 provider 未配时仍可投影。
 */
export function projectAgentProfile(input: ProjectionInput): AgentProfile {
  const tiers = resolveTierMap(input);
  const behavior = resolveBehavior(input.agent);

  const profile: AgentProfile = {
    agentName: input.agent.agent_name,
    llmTiers: tiers,
    behavior,
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
  };
  // custom_params 其余字段透传（behavior 已单独提取，不重复）。
  const customParams = stripBehaviorFromCustomParams(input.agent.custom_params);
  if (Object.keys(customParams).length > 0) {
    profile.customParams = customParams;
  }
  return profile;
}

// ────────────────────────────── tier 表解析 ──────────────────────────────

function resolveTierMap(input: ProjectionInput): TierMap {
  const rawTiers = input.agent.llm_tiers ?? {};
  const defaultEntry = resolveDefaultTier(input);

  const tiers: TierMap = defaultEntry ? { default: defaultEntry } : {};
  for (const [tierName, rawTier] of Object.entries(rawTiers)) {
    if (tierName === "default") {
      continue;
    }
    const resolved = resolveScenarioTier(rawTier, input.providers, defaultEntry);
    if (resolved) {
      tiers[tierName] = resolved;
    }
  }
  return tiers;
}

/**
 * default 档解析：
 * - 有 selectedLlm → 整体替换（provider + modelName + provider 自带参数）。
 * - 否则 → 读 `agent.llm_tiers.default`，引用可解析才采用。
 * - default 引用失效或缺失 → systemLlm 可解析则回落系统 LLM（配置失效即回落，
 *   失效标注由 runtime readiness 的 fallback_reason 承担）。
 * - 都没有 → null（default 可缺，run 守卫 default 必填）。
 */
function resolveDefaultTier(input: ProjectionInput): ResolvedTier | null {
  if (input.selectedLlm) {
    return buildTierFromProvider(input.selectedLlm.provider, input.selectedLlm.modelName);
  }
  const rawDefault = input.agent.llm_tiers?.default;
  if (rawDefault && providerRefResolves(input.providers, rawDefault)) {
    return resolveTierWithProviderRef(rawDefault, input.providers);
  }
  if (input.systemLlm && providerRefResolves(input.providers, input.systemLlm)) {
    return resolveTierWithProviderRef(input.systemLlm, input.providers);
  }
  return null;
}

/**
 * 场景 tier 解析（非 default）：
 * - 引用可解析（provider + 模型均在）→ 解析引用；引用失效（悬空/模型下架/半空）
 *   → fallback 到 default 档（场景 tier 是优化项，不可强求）。
 * - 标量字段（temperature/maxCompletionTokens/maxContextTokens）tier → default 回落。
 */
function resolveScenarioTier(
  rawTier: AgentLlmConfig,
  providers: ModelProviderConfig[],
  defaultEntry: ResolvedTier | null,
): ResolvedTier | null {
  const resolved = providerRefResolves(providers, rawTier)
    ? resolveTierWithProviderRef(rawTier, providers)
    : null;
  // 场景 tier 引用失效或缺档：回落 default（不抛错，场景 tier 可缺）。
  const base = resolved ?? defaultEntry;
  if (!base) {
    return null;
  }
  return {
    provider: base.provider,
    modelName: base.modelName,
    temperature: pickNumber(rawTier.temperature, base.temperature),
    maxCompletionTokens: pickNumber(rawTier.max_completion_tokens, base.maxCompletionTokens),
    maxContextTokens: pickNumber(rawTier.max_context_tokens, base.maxContextTokens),
    extraParams: compactRecord(defaultEntry?.extraParams, rawTier.extra_params),
    thinkingLevel: normalizeThinkingLevel(rawTier.thinking_level) ?? base.thinkingLevel ?? null,
  };
}

/** tier 配置带 provider 引用：解析引用 → 内联完整 provider，再 merge tier 字段。 */
function resolveTierWithProviderRef(
  rawTier: AgentLlmConfig,
  providers: ModelProviderConfig[],
): ResolvedTier | null {
  const provider = findProviderByRef(providers, {
    provider: rawTier.provider ?? null,
    provider_type: rawTier.provider_type ?? null,
  });
  if (!provider) {
    return null;
  }
  const modelName = normalizeString(rawTier.model_name);
  if (!modelName) {
    return null;
  }
 const built = buildTierFromProvider(provider, modelName);
 // tier 显式参数覆盖 provider 自带参数。
 return {
   provider: built.provider,
   modelName: built.modelName,
   temperature: pickNumber(rawTier.temperature, built.temperature),
    maxCompletionTokens: pickNumber(rawTier.max_completion_tokens, built.maxCompletionTokens),
   maxContextTokens: pickNumber(rawTier.max_context_tokens, built.maxContextTokens),
   extraParams: compactRecord(built.extraParams, rawTier.extra_params),
   thinkingLevel: normalizeThinkingLevel(rawTier.thinking_level),
 };
}

/**
 * provider → ResolvedTier：所选模型条目的参数作为底座。
 * 参数来源：模型条目 temperature / max_completion_tokens / max_context_tokens + provider extra_params。
 * 条目能力位（supports_function_calling / 输入模态派生的 supports_vision）随参数一并下沉到
 * 内联 provider 副本，SDK 协议选择与视觉门控等读 tier.provider 的消费点无需感知模型级配置。
 */
function buildTierFromProvider(provider: ModelProviderConfig, modelName: string): ResolvedTier {
  const entry = findModelEntry(provider, modelName);
  return {
    provider: mergeModelEntryIntoProvider(provider, entry),
    modelName,
    temperature: pickNumber(entry?.temperature, null),
    maxCompletionTokens: pickNumber(entry?.max_completion_tokens, null),
    maxContextTokens: pickNumber(entry?.max_context_tokens, null),
    extraParams: compactRecord((provider as Record<string, unknown>).extra_params),
  };
}

function findModelEntry(provider: ModelProviderConfig, modelName: string): ProviderModelEntry | null {
  // 精确匹配（trim 后 ===，不归一大小写），与 readiness.isModelAvailable 的归一匹配（trim+小写）
  // 口径不同：错配时条目失配 → 能力位按未知保守处理。所有 supports_vision 消费点共用本查找
  // 保持对称，勿单点改成归一匹配打破两路一致；要统一须连 readiness 一起动。
  const target = modelName.trim();
  return provider.models.find((model) => model.name === target) ?? null;
}

/**
 * 主模型视觉能力判定：供发送前变换等拿到原始 provider + modelName 的消费点复用，
 * 与执行期读 profile.llmTiers.default.provider.supports_vision 同源。
 * 不能直接读原始 provider.supports_vision——那是 LEGACY_PROVIDER_FIELDS 水合剥离的
 * 废弃字段，原始形态恒为空；能力位只在 buildTierFromProvider 合并模型条目时派生。
 */
export function providerModelSupportsVision(provider: ModelProviderConfig, modelName: string): boolean {
  return buildTierFromProvider(provider, modelName).provider.supports_vision === true;
}

/**
 * 原始 provider + 模型名 → 合并了模型条目（参数/能力位/thinking_kind/thinking_levels）
 * 的调用形状：任何绕过 agent 投影直连 llmClient 的调用点（会话标题生成等）必须经此
 * 桥接——思考形状在模型条目上，原始 provider 不带，直连会在档位请求时抛
 * "thinking_kind is missing"。条目缺失时返回原样（后续请求面报错）。
 */
export function providerWithModelEntry(provider: ModelProviderConfig, modelName: string): ModelProviderConfig {
  return mergeModelEntryIntoProvider(provider, findModelEntry(provider, modelName)) as unknown as ModelProviderConfig;
}

/**
 * 模型条目的参数/能力位显式写入内联 provider 副本；条目未配置的键置 null，
 * 避免 provider 透传字段里的残留旧值在模型切换后继续生效。
 * supports_vision 是派生位：输入模态含 image 即具备图片输入能力（agent-llm 消费点零感知）。
 * thinking_kind / thinking_levels 是模型级思考声明（形状 + 强度子集），agent-llm
 * describeThinking 据此显式定形（无推断，缺失即报错——条目缺失时置 null 让请求面报错）。
 * provider_type（厂商）→ api_format：agent-llm 按 API 格式分发协议，厂商不是分发键。
 */
function mergeModelEntryIntoProvider(provider: ModelProviderConfig, entry: ProviderModelEntry | null): ProviderConfig {
  const merged: Record<string, unknown> = { ...provider };
  merged.provider_type = provider.api_format ?? provider.provider_type;
  merged.temperature = entry?.temperature ?? null;
  merged.max_completion_tokens = entry?.max_completion_tokens ?? null;
  merged.max_context_tokens = entry?.max_context_tokens ?? null;
  merged.supports_function_calling = entry?.supports_function_calling ?? null;
  merged.supports_vision = entry?.input_modalities?.includes("image") ?? null;
  merged.thinking_kind = entry?.thinking_kind ?? null;
  merged.thinking_levels = entry?.thinking_levels ?? null;
  merged.reasoning_field = entry?.reasoning_field ?? null;
  return merged as unknown as ProviderConfig;
}

// ────────────────────────────── behavior 投影 ──────────────────────────────

function resolveBehavior(agent: AgentConfig): AgentProfile["behavior"] {
  return projectBehavior(agent);
}

/**
 * 只投影 prompt 所需的 behavior（systemPrompt + compression 设置）——调试/preview 场景用。
 * 不解析 LLM tier，故 agent 缺 default tier / provider 未加载时仍可构建 system prompt。
 */
export function projectBehavior(agent: AgentConfig): AgentProfile["behavior"] {
  const behavior = asRecord(agent.custom_params.behavior);
  const systemPrompt = behavior ? normalizeString(behavior.system_prompt) ?? "" : "";
  const result: AgentProfile["behavior"] = {
    systemPrompt,
    compressionTriggerRatio: pickNumber(behavior?.compression_trigger_ratio, null),
    preserveRecentTurns: pickNumber(behavior?.preserve_recent_turns, null),
  };
  return result;
}

/** 从 custom_params 透传副本中移除 behavior（已单独投影到 profile.behavior）。 */
function stripBehaviorFromCustomParams(customParams: Record<string, unknown>): Record<string, unknown> {
  if (customParams.behavior === undefined) {
    return { ...customParams };
  }
  const { behavior: _behavior, ...rest } = customParams;
  return rest;
}

// ────────────────────────────── 小工具 ──────────────────────────────

function pickNumber(primary: unknown, fallback: number | null): number | null {
  const n = numberOrNull(primary);
  return n !== null ? n : fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** tier.thinking_level 合法性校验；非法值（含空串）返回 null = 不设默认档位。 */
function normalizeThinkingLevel(value: unknown): ThinkingLevel | null {
  return typeof value === "string" && (ALL_THINKING_LEVELS as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : null;
}
