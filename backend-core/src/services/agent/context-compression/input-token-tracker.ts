import type { ChatMessage, TokenUsage } from "@ragsystem/agent-llm";
import { countMessagesTokens, type ContextUsageSnapshot } from "@ragsystem/agent-sdk";

const MAX_CORRECTION_FACTOR = 4;
export const CONTEXT_TOKEN_USAGE_METADATA_KEY = "_context_token_usage";

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
  workingMessageTokens: number;
  systemPromptTokens: number | null;
  budgetTokens: number | null;
}

export interface PersistedContextTokenUsage {
  contextTokens: number;
  providerInputTokens: number;
  providerOutputTokens: number;
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
  return {
    contextTokens,
    providerInputTokens,
    providerOutputTokens: nonNegativeInteger(entry.provider_output_tokens) ?? 0,
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
  return {
    contextTokens,
    providerInputTokens,
    providerOutputTokens: nonNegativeInteger(entry.provider_output_tokens) ?? 0,
    budgetTokens: nonNegativeInteger(entry.budget_tokens) ?? 0,
    systemPromptTokens: nonNegativeInteger(entry.system_prompt_tokens) ?? 0,
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
