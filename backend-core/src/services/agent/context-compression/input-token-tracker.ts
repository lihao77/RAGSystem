import type { ChatMessage, TokenUsage } from "@ragsystem/agent-llm";
import { countMessagesTokens, type ContextUsageSnapshot } from "@ragsystem/agent-sdk";

const MAX_CORRECTION_FACTOR = 4;
export const CONTEXT_TOKEN_USAGE_METADATA_KEY = "_context_token_usage";
/** 会话级缓存命中累计（每次 LLM 调用后并入；与 _context_token_usage 并存，独立 key 不受 per-thread 基线结构约束）。 */
export const SESSION_CACHE_TOTALS_METADATA_KEY = "_cache_session_totals";

export interface SessionCacheTotals {
  cachedInputTokens: number;
  cacheCreationInputTokens: number;
  inputTokens: number;
}

export interface InputTokenTrackerIdentity {
  threadKey: string;
  agentName: string;
  providerKey: string;
  modelName: string;
}

export interface ProviderAdjustedInputPrediction {
  inputTokens: number;
  systemPromptTokens: number | null;
}

interface InputTokenObservation {
  contextTokens: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  cachedInputTokens: number | null;
  cacheCreationInputTokens: number | null;
  workingMessageTokens: number;
  systemPromptTokens: number | null;
  budgetTokens: number | null;
}

export interface PersistedContextTokenUsage {
  contextTokens: number;
  providerInputTokens: number;
  providerOutputTokens: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
  budgetTokens: number;
  systemPromptTokens: number;
}

/** Keeps provider usage inside one run and projects it over messages added after that request. */
export class RuntimeInputTokenTracker {
  private observation: InputTokenObservation | null = null;
  private correctionFactor = 1;

  observe(
    usage: TokenUsage,
    requestUsage: ContextUsageSnapshot | undefined,
    workingMessages: readonly ChatMessage[],
  ): boolean {
    if (!Number.isFinite(usage.inputTokens) || usage.inputTokens <= 0) return false;
    const actualInputTokens = Math.floor(usage.inputTokens);
    const actualOutputTokens = Number.isFinite(usage.outputTokens)
      ? Math.max(0, Math.floor(usage.outputTokens))
      : 0;
    if (requestUsage && requestUsage.totalTokens > 0) {
      const ratio = actualInputTokens / requestUsage.totalTokens;
      if (Number.isFinite(ratio) && ratio > 0) {
        this.correctionFactor = Math.max(
          this.correctionFactor,
          Math.min(MAX_CORRECTION_FACTOR, ratio),
        );
      }
    }
    this.observation = {
      contextTokens: actualInputTokens + actualOutputTokens,
      providerInputTokens: actualInputTokens,
      providerOutputTokens: actualOutputTokens,
      cachedInputTokens: usage.cachedInputTokens ?? null,
      cacheCreationInputTokens: usage.cacheCreationInputTokens ?? null,
      workingMessageTokens: countMessagesTokens(workingMessages),
      systemPromptTokens: requestUsage?.systemPromptTokens ?? null,
      budgetTokens: requestUsage?.budgetTokens ?? null,
    };
    return true;
  }

  predict(workingMessages: readonly ChatMessage[]): ProviderAdjustedInputPrediction | null {
    if (!this.observation) return null;
    const estimatedDelta = countMessagesTokens(workingMessages) - this.observation.workingMessageTokens;
    const adjustedDelta = estimatedDelta >= 0
      ? Math.ceil(estimatedDelta * this.correctionFactor)
      : Math.floor(estimatedDelta * this.correctionFactor);
    return {
      inputTokens: Math.max(0, this.observation.contextTokens + adjustedDelta),
      systemPromptTokens: this.observation.systemPromptTokens,
    };
  }

  /**
   * 从会话元数据恢复上次观测基线。已知过渡:估算口径切换(如图片 token 从 base64/4 改为
   * 分辨率制)后,旧口径持久化的 working_message_tokens 偏大,新 run 首轮 predict 会得到大负
   * 增量、预测钳 0 而跳过一次本可能需要的压缩;首轮 round.after 重新 observe 即自愈。
   * 数值口径过渡而非数据形状变更,不登记 MIGRATIONS.md。
   */
  restore(metadata: Record<string, unknown>, identity: InputTokenTrackerIdentity): boolean {
    const root = recordValue(metadata[CONTEXT_TOKEN_USAGE_METADATA_KEY]);
    const entry = recordValue(root?.[normalizeThreadKey(identity.threadKey)]);
    if (!entry) return false;
    if (
      entry.agent_name !== identity.agentName
      || entry.provider_key !== identity.providerKey
      || entry.model_name !== identity.modelName
    ) {
      return false;
    }
    const contextTokens = positiveInteger(entry.context_tokens)
      ?? positiveInteger(entry.actual_input_tokens);
    const providerInputTokens = positiveInteger(entry.provider_input_tokens)
      ?? positiveInteger(entry.actual_input_tokens)
      ?? contextTokens;
    const providerOutputTokens = nonNegativeInteger(entry.provider_output_tokens) ?? 0;
    const workingMessageTokens = nonNegativeInteger(entry.working_message_tokens);
    if (contextTokens === null || providerInputTokens === null || workingMessageTokens === null) return false;
    this.observation = {
      contextTokens,
      providerInputTokens,
      providerOutputTokens,
      cachedInputTokens: nonNegativeInteger(entry.cached_input_tokens),
      cacheCreationInputTokens: nonNegativeInteger(entry.cache_creation_input_tokens),
      workingMessageTokens,
      systemPromptTokens: nonNegativeInteger(entry.system_prompt_tokens),
      budgetTokens: nonNegativeInteger(entry.budget_tokens),
    };
    const persistedFactor = finitePositive(entry.correction_factor);
    this.correctionFactor = persistedFactor === null
      ? 1
      : Math.min(MAX_CORRECTION_FACTOR, Math.max(1, persistedFactor));
    return true;
  }

  metadataPatch(identity: InputTokenTrackerIdentity): Record<string, unknown> | null {
    if (!this.observation) return null;
    return {
      [CONTEXT_TOKEN_USAGE_METADATA_KEY]: {
        [normalizeThreadKey(identity.threadKey)]: {
          agent_name: identity.agentName,
          provider_key: identity.providerKey,
          model_name: identity.modelName,
          context_tokens: this.observation.contextTokens,
          provider_input_tokens: this.observation.providerInputTokens,
          provider_output_tokens: this.observation.providerOutputTokens,
          ...(this.observation.cachedInputTokens !== null
            ? { cached_input_tokens: this.observation.cachedInputTokens }
            : {}),
          ...(this.observation.cacheCreationInputTokens !== null
            ? { cache_creation_input_tokens: this.observation.cacheCreationInputTokens }
            : {}),
          // Retained for compatibility with older readers during rolling upgrades.
          actual_input_tokens: this.observation.providerInputTokens,
          working_message_tokens: this.observation.workingMessageTokens,
          system_prompt_tokens: this.observation.systemPromptTokens,
          budget_tokens: this.observation.budgetTokens,
          correction_factor: this.correctionFactor,
        },
      },
    };
  }
}

export function readPersistedContextTokenUsage(
  metadata: Record<string, unknown>,
  identity: InputTokenTrackerIdentity,
): PersistedContextTokenUsage | null {
  const root = recordValue(metadata[CONTEXT_TOKEN_USAGE_METADATA_KEY]);
  const entry = recordValue(root?.[normalizeThreadKey(identity.threadKey)]);
  if (!entry) return null;
  if (
    entry.agent_name !== identity.agentName
    || entry.provider_key !== identity.providerKey
    || entry.model_name !== identity.modelName
  ) return null;

  const contextTokens = positiveInteger(entry.context_tokens)
    ?? positiveInteger(entry.actual_input_tokens);
  const providerInputTokens = positiveInteger(entry.provider_input_tokens)
    ?? positiveInteger(entry.actual_input_tokens);
  if (contextTokens === null || providerInputTokens === null) return null;
  const cachedInputTokens = nonNegativeInteger(entry.cached_input_tokens);
  const cacheCreationInputTokens = nonNegativeInteger(entry.cache_creation_input_tokens);
  return {
    contextTokens,
    providerInputTokens,
    providerOutputTokens: nonNegativeInteger(entry.provider_output_tokens) ?? 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== null ? { cacheCreationInputTokens } : {}),
    budgetTokens: nonNegativeInteger(entry.budget_tokens) ?? 0,
    systemPromptTokens: nonNegativeInteger(entry.system_prompt_tokens) ?? 0,
  };
}

/** Read the latest provider measurement for display, independent of the currently selected model. */
export function readPersistedSessionContextTokenUsage(
  metadata: Record<string, unknown>,
  threadKey: string,
): PersistedContextTokenUsage | null {
  const root = recordValue(metadata[CONTEXT_TOKEN_USAGE_METADATA_KEY]);
  const entry = recordValue(root?.[normalizeThreadKey(threadKey)]);
  if (!entry) return null;
  const contextTokens = positiveInteger(entry.context_tokens)
    ?? positiveInteger(entry.actual_input_tokens);
  const providerInputTokens = positiveInteger(entry.provider_input_tokens)
    ?? positiveInteger(entry.actual_input_tokens);
  if (contextTokens === null || providerInputTokens === null) return null;
  const cachedInputTokens = nonNegativeInteger(entry.cached_input_tokens);
  const cacheCreationInputTokens = nonNegativeInteger(entry.cache_creation_input_tokens);
  return {
    contextTokens,
    providerInputTokens,
    providerOutputTokens: nonNegativeInteger(entry.provider_output_tokens) ?? 0,
    ...(cachedInputTokens !== null ? { cachedInputTokens } : {}),
    ...(cacheCreationInputTokens !== null ? { cacheCreationInputTokens } : {}),
    budgetTokens: nonNegativeInteger(entry.budget_tokens) ?? 0,
    systemPromptTokens: nonNegativeInteger(entry.system_prompt_tokens) ?? 0,
  };
}

/** 读取会话级缓存命中累计（_cache_session_totals）；未写入过返回 null，部分字段非法时按字段容错收敛。 */
export function readPersistedSessionCacheTotals(
  metadata: Record<string, unknown>,
): SessionCacheTotals | null {
  const entry = recordValue(metadata[SESSION_CACHE_TOTALS_METADATA_KEY]);
  if (!entry) return null;
  const cachedInputTokens = nonNegativeInteger(entry.cached_input_tokens);
  const cacheCreationInputTokens = nonNegativeInteger(entry.cache_creation_input_tokens);
  const inputTokens = nonNegativeInteger(entry.input_tokens);
  // 全部字段非法才视为不存在；单字段损坏（滚动升级旧写入/外部改写）只收敛该字段、
  // 保留其余有效累计——整体判无效会让下一次累计从 0 重建，历史命中量被静默清零。
  if (cachedInputTokens === null && cacheCreationInputTokens === null && inputTokens === null) return null;
  return {
    cachedInputTokens: cachedInputTokens ?? 0,
    cacheCreationInputTokens: cacheCreationInputTokens ?? 0,
    inputTokens: inputTokens ?? 0,
  };
}

function normalizeThreadKey(threadKey: string): string {
  return threadKey.trim() || "root";
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}
