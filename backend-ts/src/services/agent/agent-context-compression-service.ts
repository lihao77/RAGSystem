import type { AgentConfig } from "../../contracts/agent-config.js";
import type { MessageInfo } from "../../contracts/session.js";
import type { SystemConfigData } from "../../contracts/system-config.js";
import type { ModelProviderConfig } from "../../contracts/model-adapter.js";
import type { IMessageStore } from "../../contracts/conversation-store/index.js";
import type { ChatMessage, LlmChatClient } from "../integrations/llm-chat-client.js";
import type { SystemConfigService } from "../config/system-config-service.js";
import { resolveCompressionView } from "./agent-runtime-context-builder.js";

export interface RuntimeContextSettings {
  compressionTriggerRatio: number;
  summarizeMaxTokens: number;
  preserveRecentTurns: number;
  systemPromptReserve: number;
  minContextBudget: number;
}

export interface ContextCompressionEvent {
  type: "context.compression_start" | "context.compression_summary";
  data: Record<string, unknown>;
}

export interface ContextCompressionResult {
  status: "skipped" | "success" | "fallback";
  reason: string;
  budgetTokens: number;
  historyTokens: number;
  thresholdTokens: number;
  summaryMessage?: MessageInfo | undefined;
  replacedMessageCount: number;
  replacesUpToSeq: number | null;
}

export interface ForceContextCompressionResult {
  status: "skipped" | "success" | "fallback";
  reason: string;
  before: number;
  after: number;
  tokens_saved: number;
  summary_content: string | null;
  replaces_up_to_seq: number | null;
  replaced_message_count: number;
  summary_message_id: string | null;
}

interface CompressIfNeededInput {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  threadKey?: string | null | undefined;
  childAgentId?: string | null | undefined;
  signal?: AbortSignal | undefined;
  onEvent?: ((event: ContextCompressionEvent) => void | Promise<void>) | undefined;
}

const CONTEXT_WINDOW_SAFETY_FACTOR = 0.9;
const DEFAULT_CONTEXT_FALLBACK_MULTIPLIER = 3;
const DEFAULT_MAX_COMPLETION_TOKENS = 4096;
const DEFAULT_HISTORY_SCAN_LIMIT = 10_000;
const COMPACT_SUMMARY_PREFIX = "本次会话从之前的对话继续，以下是该对话早期内容的摘要。\n\n";
const NO_TOOLS_PREAMBLE = "你正在生成上下文压缩摘要。不要调用工具，不要输出工具调用协议，只输出摘要文本。\n\n";
const NO_TOOLS_TRAILER = "\n\n再次提醒：不要调用工具，只输出 <summary> 中的摘要内容或纯文本摘要。";
const COMPACT_PROMPT_BODY = `<summary>
1. 主要目标：
   [用户要完成什么]

2. 已完成内容：
   [已经完成的关键工作]

3. 关键决策：
   [重要设计选择、约束、用户偏好]

4. 当前状态：
   [最后进展、运行状态、未完成事项]

5. 重要上下文：
   [文件、接口、配置、错误、命令结果等后续必须知道的信息]

6. 下一步：
   [建议继续做什么]
</summary>`;

export class AgentContextCompressionService {
  constructor(
    private readonly conversationStore: IMessageStore,
    private readonly llmChatClient: LlmChatClient,
    private readonly systemConfig: SystemConfigService,
  ) {}

  resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig): number {
    return resolveContextBudget(agent, provider, this.systemConfig.getConfig());
  }

  resolveContextSettings(agent: AgentConfig): RuntimeContextSettings {
    return resolveRuntimeContextSettings(agent, this.systemConfig.getConfig());
  }

  async compressIfNeeded(input: CompressIfNeededInput): Promise<ContextCompressionResult> {
    const threadKey = input.threadKey?.trim() || "root";
    const settings = this.resolveContextSettings(input.agent);
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider);
    const rawMessages = this.conversationStore
      .listMessages(input.sessionId, DEFAULT_HISTORY_SCAN_LIMIT, 0, threadKey)
      .items.filter(isCompressibleHistoryMessage);
    const historyResolved = resolveCompressionView(rawMessages);
    const historyTokens = countMessagesTokens(historyResolved);
    const thresholdTokens = Math.floor(budgetTokens * settings.compressionTriggerRatio);

    if (historyTokens < thresholdTokens) {
      return skipped("below_threshold", budgetTokens, historyTokens, thresholdTokens);
    }

    const startIndex = historyResolved[0]?.metadata.compression ? 1 : 0;
    const candidates = historyResolved.slice(startIndex);
    const preserveCount = settings.preserveRecentTurns * 2;
    if (candidates.length <= preserveCount) {
      return skipped("insufficient_candidates", budgetTokens, historyTokens, thresholdTokens);
    }

    const segment = preserveCount > 0 ? candidates.slice(0, candidates.length - preserveCount) : [...candidates];
    const replacesUpToSeq = lastPositiveSeq(segment);
    if (!segment.length || replacesUpToSeq === null) {
      return skipped("missing_segment_seq", budgetTokens, historyTokens, thresholdTokens);
    }

    const existingSummary = startIndex === 1 ? historyResolved[0]?.content ?? "" : "";
    await input.onEvent?.({
      type: "context.compression_start",
      data: {
        message_count: segment.length,
        has_existing_summary: Boolean(existingSummary),
        history_tokens: historyTokens,
        threshold_tokens: thresholdTokens,
        budget_tokens: budgetTokens,
        trigger_ratio: settings.compressionTriggerRatio,
        thread_key: threadKey,
        conversation_scope: threadKey === "root" ? "root" : "child",
        visible_to_user: threadKey === "root",
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
        agent_name: input.agent.agent_name,
      },
    });

    let summaryContent: string;
    let status: ContextCompressionResult["status"] = "success";
    let reason = "success";
    try {
      summaryContent = await this.generateSummary({
        agent: input.agent,
        provider: input.provider,
        modelName: input.modelName,
        segment,
        existingSummary,
        maxTokens: settings.summarizeMaxTokens,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        throw error;
      }
      status = "fallback";
      reason = "summary_failed";
      summaryContent = formatFallbackSummary(segment.length, error);
    }

    const summaryMessage = this.conversationStore.insertCompressionMessage({
      sessionId: input.sessionId,
      summaryContent,
      replacesUpToSeq,
      threadKey,
      childAgentId: input.childAgentId ?? null,
      metadata: {
        agent: input.agent.agent_name,
        run_id: input.runId,
        request_id: input.requestId,
        task_id: input.taskId,
        msg_type: "context_compression_summary",
        compression_strategy: status === "success" ? "llm_summarize" : "fallback_truncate",
        replaced_message_count: segment.length,
        history_tokens_before: historyTokens,
        threshold_tokens: thresholdTokens,
        budget_tokens: budgetTokens,
      },
    });

    await input.onEvent?.({
      type: "context.compression_summary",
      data: {
        id: summaryMessage.id,
        seq: summaryMessage.seq,
        content: summaryContent,
        replaces_up_to_seq: replacesUpToSeq,
        replaced_message_count: segment.length,
        thread_key: threadKey,
        child_agent_id: input.childAgentId ?? null,
        conversation_scope: threadKey === "root" ? "root" : "child",
        visible_to_user: threadKey === "root",
        run_id: input.runId,
        task_id: input.taskId,
        request_id: input.requestId,
        agent_name: input.agent.agent_name,
        status,
        reason,
      },
    });

    return {
      status,
      reason,
      budgetTokens,
      historyTokens,
      thresholdTokens,
      summaryMessage,
      replacedMessageCount: segment.length,
      replacesUpToSeq,
    };
  }

  async forceCompactSession(input: {
    sessionId: string;
    agent: AgentConfig;
    provider: ModelProviderConfig;
    modelName: string;
    runId?: string | null | undefined;
    taskId?: string | null | undefined;
    requestId?: string | null | undefined;
    threadKey?: string | null | undefined;
    signal?: AbortSignal | undefined;
    onEvent?: ((event: ContextCompressionEvent) => void | Promise<void>) | undefined;
  }): Promise<ForceContextCompressionResult> {
    const threadKey = input.threadKey?.trim() || "root";
    const settings = this.resolveContextSettings(input.agent);
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider);
    const rawMessages = this.conversationStore
      .listMessages(input.sessionId, DEFAULT_HISTORY_SCAN_LIMIT, 0, threadKey)
      .items.filter(isCompressibleHistoryMessage);
    const historyResolved = resolveCompressionView(rawMessages);
    if (!historyResolved.length) {
      return forceSkipped("no_history", rawMessages.length);
    }

    const beforeTokens = countMessagesTokens(historyResolved);
    const startIndex = historyResolved[0]?.metadata.compression ? 1 : 0;
    const candidates = historyResolved.slice(startIndex);
    const preserveCount = settings.preserveRecentTurns * 2;
    if (candidates.length <= preserveCount) {
      return forceSkipped("insufficient_candidates", rawMessages.length);
    }
    const segment = preserveCount > 0 ? candidates.slice(0, candidates.length - preserveCount) : [...candidates];
    const replacesUpToSeq = lastPositiveSeq(segment);
    if (!segment.length || replacesUpToSeq === null) {
      return forceSkipped("missing_segment_seq", rawMessages.length);
    }

    const runId = input.runId ?? null;
    const taskId = input.taskId ?? null;
    const requestId = input.requestId ?? null;
    const existingSummary = startIndex === 1 ? historyResolved[0]?.content ?? "" : "";
    await input.onEvent?.({
      type: "context.compression_start",
      data: {
        message_count: segment.length,
        has_existing_summary: Boolean(existingSummary),
        history_tokens: beforeTokens,
        threshold_tokens: 0,
        budget_tokens: budgetTokens,
        trigger_ratio: 0,
        thread_key: threadKey,
        conversation_scope: threadKey === "root" ? "root" : "child",
        visible_to_user: threadKey === "root",
        run_id: runId,
        task_id: taskId,
        request_id: requestId,
        agent_name: input.agent.agent_name,
        forced: true,
      },
    });

    let summaryContent: string;
    let status: ForceContextCompressionResult["status"] = "success";
    let reason = "success";
    try {
      summaryContent = await this.generateSummary({
        agent: input.agent,
        provider: input.provider,
        modelName: input.modelName,
        segment,
        existingSummary,
        maxTokens: settings.summarizeMaxTokens,
        signal: input.signal,
      });
    } catch (error) {
      if (input.signal?.aborted) {
        throw error;
      }
      status = "fallback";
      reason = "summary_failed";
      summaryContent = formatFallbackSummary(segment.length, error);
    }

    const summaryMessage = this.conversationStore.insertCompressionMessage({
      sessionId: input.sessionId,
      summaryContent,
      replacesUpToSeq,
      threadKey,
      metadata: {
        agent: input.agent.agent_name,
        run_id: runId,
        request_id: requestId,
        task_id: taskId,
        msg_type: "context_compression_summary",
        compression_strategy: status === "success" ? "llm_summarize" : "fallback_truncate",
        replaced_message_count: segment.length,
        history_tokens_before: beforeTokens,
        threshold_tokens: 0,
        budget_tokens: budgetTokens,
        forced: true,
      },
    });

    const messagesAfter = resolveCompressionView(this.conversationStore.listMessages(input.sessionId, DEFAULT_HISTORY_SCAN_LIMIT, 0, threadKey).items);
    const afterTokens = countMessagesTokens(messagesAfter);
    await input.onEvent?.({
      type: "context.compression_summary",
      data: {
        id: summaryMessage.id,
        seq: summaryMessage.seq,
        content: summaryContent,
        replaces_up_to_seq: replacesUpToSeq,
        replaced_message_count: segment.length,
        thread_key: threadKey,
        child_agent_id: null,
        conversation_scope: threadKey === "root" ? "root" : "child",
        visible_to_user: threadKey === "root",
        run_id: runId,
        task_id: taskId,
        request_id: requestId,
        agent_name: input.agent.agent_name,
        status,
        reason,
        forced: true,
      },
    });

    return {
      status,
      reason,
      before: rawMessages.length,
      after: messagesAfter.length,
      tokens_saved: Math.max(0, beforeTokens - afterTokens),
      summary_content: summaryContent,
      replaces_up_to_seq: replacesUpToSeq,
      replaced_message_count: segment.length,
      summary_message_id: summaryMessage.id,
    };
  }

  private async generateSummary(input: {
    agent: AgentConfig;
    provider: ModelProviderConfig;
    modelName: string;
    segment: MessageInfo[];
    existingSummary: string;
    maxTokens: number;
    signal?: AbortSignal | undefined;
  }): Promise<string> {
    const request: Parameters<LlmChatClient["complete"]>[0] = {
      messages: buildSummaryMessages(input.segment, input.existingSummary),
      model: input.modelName,
      provider: input.provider,
      agent: input.agent,
      temperature: 0.2,
      maxCompletionTokens: input.maxTokens,
    };
    if (input.signal !== undefined) {
      request.signal = input.signal;
    }
    const response = await this.llmChatClient.complete(request);
    const summary = formatCompactResponse(response.content);
    if (!summary.trim()) {
      throw new Error("summary model returned empty content");
    }
    return summary;
  }
}

export function resolveRuntimeContextSettings(agent: AgentConfig, systemConfig: SystemConfigData): RuntimeContextSettings {
  const contextConfig = asRecord(systemConfig.context) ?? {};
  const behaviorConfig = asRecord(agent.custom_params.behavior) ?? {};
  return {
    compressionTriggerRatio: clamp(
      numberOrDefault(behaviorConfig.compression_trigger_ratio, numberOrDefault(contextConfig.compression_trigger_ratio, 0.85)),
      0.5,
      0.99,
    ),
    summarizeMaxTokens: positiveIntOrDefault(
      behaviorConfig.summarize_max_tokens,
      positiveIntOrDefault(contextConfig.summarize_max_tokens, 300),
    ),
    preserveRecentTurns: positiveIntOrDefault(
      behaviorConfig.preserve_recent_turns,
      positiveIntOrDefault(contextConfig.preserve_recent_turns, 3),
    ),
    systemPromptReserve: nonNegativeIntOrDefault(contextConfig.system_prompt_reserve, 2000),
    minContextBudget: positiveIntOrDefault(contextConfig.min_context_budget, 4000),
  };
}

export function resolveContextBudget(
  agent: AgentConfig,
  provider: ModelProviderConfig | null,
  systemConfig: SystemConfigData,
): number {
  const settings = resolveRuntimeContextSettings(agent, systemConfig);
  const systemLlmConfig = asRecord(systemConfig.llm) ?? {};
  const defaultLlm = agent.llm_tiers?.default;
  const contextWindow =
    positiveInt(provider?.max_context_tokens) ??
    positiveInt(defaultLlm?.max_context_tokens) ??
    positiveInt(systemLlmConfig.max_context_tokens);
  const maxCompletionTokens =
    positiveInt(defaultLlm?.max_completion_tokens) ??
    positiveInt(provider?.max_completion_tokens) ??
    positiveInt(provider?.max_tokens) ??
    positiveInt(systemLlmConfig.max_completion_tokens) ??
    DEFAULT_MAX_COMPLETION_TOKENS;

  if (contextWindow !== null) {
    const budget = Math.floor(contextWindow * CONTEXT_WINDOW_SAFETY_FACTOR) - settings.systemPromptReserve - maxCompletionTokens;
    return Math.max(budget, settings.minContextBudget);
  }
  return Math.max(Math.floor(maxCompletionTokens * DEFAULT_CONTEXT_FALLBACK_MULTIPLIER), settings.minContextBudget);
}

export function estimateTokens(content: string): number {
  if (!content) {
    return 0;
  }
  const cjkChars = content.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const nonCjk = content.length - cjkChars;
  return Math.max(1, cjkChars + Math.ceil(nonCjk / 4));
}

function buildSummaryMessages(segment: MessageInfo[], existingSummary: string): ChatMessage[] {
  const existingSection = existingSummary.trim()
    ? `\n\n---已有历史摘要（将与新内容合并）---\n${existingSummary.trim()}\n---end---`
    : "";
  const conversationText = segment
    .map((message) => `${message.role}: ${message.content.trim()}`)
    .filter((line) => line.trim())
    .join("\n") || "（无内容）";
  return [
    {
      role: "system",
      content: "你是一名专业的对话摘要助手。你的任务是将对话压缩为结构化摘要，以便后续会话继续进行。不要调用任何工具，只输出文本。",
    },
    {
      role: "user",
      content: `${NO_TOOLS_PREAMBLE}${COMPACT_PROMPT_BODY}${existingSection}\n\n---待压缩对话内容---\n${conversationText}\n---end---${NO_TOOLS_TRAILER}`,
    },
  ];
}

function formatCompactResponse(raw: string): string {
  const withoutAnalysis = raw.replace(/<analysis>[\s\S]*?<\/analysis>/gi, "");
  const summaryMatch = withoutAnalysis.match(/<summary>([\s\S]*?)<\/summary>/i);
  const summaryBody = (summaryMatch?.[1] ?? withoutAnalysis).replace(/\n{3,}/g, "\n\n").trim();
  if (!summaryBody) {
    return "";
  }
  return `${COMPACT_SUMMARY_PREFIX}Summary:\n${summaryBody}`;
}

function formatFallbackSummary(replacedMessages: number, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${COMPACT_SUMMARY_PREFIX}Summary:\nLLM 摘要不可用，已降级截断 ${replacedMessages} 条较早历史消息以保持上下文预算。\n\n降级原因: ${message}`;
}

function countMessagesTokens(messages: MessageInfo[]): number {
  return messages.reduce((total, message) => total + estimateTokens(message.content), 0);
}

function isCompressibleHistoryMessage(message: MessageInfo): boolean {
  return message.role === "user" || message.role === "assistant" || Boolean(message.metadata.compression);
}

function lastPositiveSeq(messages: MessageInfo[]): number | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const seq = messages[index]?.seq;
    if (typeof seq === "number" && Number.isInteger(seq) && seq > 0) {
      return seq;
    }
  }
  return null;
}

function skipped(
  reason: string,
  budgetTokens: number,
  historyTokens: number,
  thresholdTokens: number,
): ContextCompressionResult {
  return {
    status: "skipped",
    reason,
    budgetTokens,
    historyTokens,
    thresholdTokens,
    replacedMessageCount: 0,
    replacesUpToSeq: null,
  };
}

function forceSkipped(reason: string, before: number): ForceContextCompressionResult {
  return {
    status: "skipped",
    reason,
    before,
    after: before,
    tokens_saved: 0,
    summary_content: null,
    replaces_up_to_seq: null,
    replaced_message_count: 0,
    summary_message_id: null,
  };
}

function numberOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function positiveInt(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  return positiveInt(value) ?? fallback;
}

function nonNegativeIntOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
