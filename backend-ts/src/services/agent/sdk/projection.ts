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
 * 与 backend-ts 旧 resolveTierLlmParams 的差异：
 *   - 删 systemLlm 第三级（SDK 内核零兜底）
 *   - 删 resolveDefaultSource 特殊分支：selectLlm 替换 default 已在此处做完，
 *     resolved.tiers.default 永远是最终真相，readTierParams 只做两级回落
 */
import type { AgentProfile, CompressionBudgetConfig, MemoryConfig, ResolvedTier, TierMap } from "@ragsystem/agent-sdk";
import type { ProviderConfig } from "@ragsystem/agent-llm";
import type { AgentConfig, AgentLlmConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import { findProviderByRef, normalizeProviderKey } from "../../runtime/provider-lookup.js";
import { compactRecord } from "../llm-params.js";

export interface ProjectionInput {
  agent: AgentConfig;
  /** 已加载的全部 provider，用于 tier.provider 引用解析。 */
  providers: ModelProviderConfig[];
  /**
   * 前端 selectLlm 解析结果（optional）：整体替换 default 档。
   * 指向 input.providers 中的某一条 provider + 其 model_map/models 中的一个模型。
   */
  selectedLlm?: {
    provider: ModelProviderConfig;
    modelName: string;
  } | null;
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
  const memory = resolveMemory(input.agent);

  const profile: AgentProfile = {
    agentName: input.agent.agent_name,
    displayName: input.agent.display_name ?? null,
    llmTiers: tiers,
    memory,
    behavior,
  };
  // custom_params 其余字段透传（behavior 已单独提取，不重复）。
  const customParams = stripBehaviorFromCustomParams(input.agent.custom_params);
  if (Object.keys(customParams).length > 0) {
    profile.customParams = customParams;
  }
  return profile;
}

/**
 * 取 default 档已内联的 provider + modelName —— createRuntime 的顶层 provider/modelName。
 * 投影保证 tiers.default 恒在（projectAgentProfile 已抛错守卫）。
 */
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
 * - 否则 → 读 agent.llm_tiers.default，provider 引用解析 + provider 参数 merge。
 * - 都没有 → 抛错（契约：default 必填）。
 */
function resolveDefaultTier(input: ProjectionInput): ResolvedTier | null {
  if (input.selectedLlm) {
    return buildTierFromProvider(input.selectedLlm.provider, input.selectedLlm.modelName);
  }
  const rawDefault = input.agent.llm_tiers?.default;
  if (rawDefault) {
    return resolveTierWithProviderRef(rawDefault, input.providers);
  }
  return null;
}

/**
 * 场景 tier 解析（非 default）：
 * - 解析 provider 引用；引用缺失或解析失败 → fallback 到 default 档（场景 tier 是优化项，不可强求）。
 * - 标量字段（temperature/maxCompletionTokens/maxContextTokens）tier → default 回落。
 */
function resolveScenarioTier(
  rawTier: AgentLlmConfig,
  providers: ModelProviderConfig[],
  defaultEntry: ResolvedTier | null,
): ResolvedTier | null {
  const resolved = resolveTierWithProviderRef(rawTier, providers);
  // 场景 tier 无 provider 引用或解析失败：回落 default（不抛错，场景 tier 可缺）。
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
 };
}

/**
 * provider → ResolvedTier：provider 自带参数作为底座。
 * 参数来源：provider.temperature / max_completion_tokens / max_context_tokens / extra_params。
 */
function buildTierFromProvider(provider: ModelProviderConfig, modelName: string): ResolvedTier {
  return {
    provider: provider as unknown as ProviderConfig,
    modelName,
    temperature: pickNumber(provider.temperature, null),
    maxCompletionTokens: pickNumber(provider.max_completion_tokens ?? provider.max_tokens, null),
    maxContextTokens: pickNumber(provider.max_context_tokens, null),
    extraParams: compactRecord((provider as Record<string, unknown>).extra_params),
  };
}

// ────────────────────────────── behavior / memory 投影 ──────────────────────────────

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
    summarizeMaxTokens: pickNumber(behavior?.summarize_max_tokens, null),
    preserveRecentTurns: pickNumber(behavior?.preserve_recent_turns, null),
  };
  const budget = resolveCompressionBudget(behavior);
  if (budget) {
    result.budget = budget;
  }
  return result;
}

function resolveCompressionBudget(behavior: Record<string, unknown> | null): CompressionBudgetConfig | undefined {
  if (!behavior) {
    return undefined;
  }
 const budget = asRecord(behavior.compression_budget);
 if (!budget) {
   return undefined;
 }
  // CompressionBudgetConfig 字段非空 number，强制带默认回落（与 SDK DEFAULT_COMPRESSION_BUDGET 对齐）。
  return {
    contextWindowSafetyFactor: requireNumber(budget.context_window_safety_factor, 0.9),
    systemPromptReserve: requireNumber(budget.system_prompt_reserve, 2000),
    minContextBudget: requireNumber(budget.min_context_budget, 4000),
  };
}

/**
 * 投影 agent.memory → SDK MemoryConfig（snake → camel）。
 * snapshot 路径装配 SDK MemoryIndexContextSource 时用（无需完整 profile/tier 解析）。
 */
export function projectMemory(agent: AgentConfig): MemoryConfig {
  const memory = agent.memory;
  return {
    autoInject: memory.auto_inject,
    allowedScopes: memory.allowed_scopes,
    writeScopes: memory.write_scopes,
    archiveScopes: memory.archive_scopes,
  };
}

function resolveMemory(agent: AgentConfig): MemoryConfig {
  return projectMemory(agent);
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

/** 强制非空 number：无效值回落到默认（CompressionBudgetConfig 等非空字段用）。 */
function requireNumber(primary: unknown, fallback: number): number {
  return numberOrNull(primary) ?? fallback;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 选中模型可用性校验：modelName 在 provider 的模型集合中（读 model_map/models/model）。 */
export function isModelAvailableInProvider(provider: ModelProviderConfig, modelName: string): boolean {
  const target = normalizeProviderKey(modelName);
  return listChatModels(provider).some((model) => normalizeProviderKey(model) === target);
}

function listChatModels(provider: ModelProviderConfig): string[] {
  const values: string[] = [];
  collectModelValues(provider.model_map?.chat, values);
  collectModelValues(provider.model, values);
  collectModelValues(provider.models, values);
  return values;
}

function collectModelValues(value: unknown, output: string[]): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectModelValues(item, output);
    }
    return;
  }
  const normalized = normalizeString(value);
  if (normalized) {
    output.push(normalized);
  }
}
