import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { MessageInfo } from "../../../contracts/session.js";
import type { SystemConfigData } from "../../../contracts/system-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { IMessageStore } from "../../../contracts/conversation-store/index.js";
import type { ChatMessage, LlmChatClient } from "../../integrations/llm-chat-client.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import { resolveCompressionView } from "../context-builder/index.js";
import type { RuntimeModelProviderPort } from "../../runtime/runtime-core-service.js";
import { findProviderByRef, normalizeProviderKey } from "../../runtime/provider-lookup.js";
import { resolveRequestLlmParams } from "../../runtime/llm-params.js";

export interface RuntimeContextSettings {
  compressionTriggerRatio: number;
  summarizeMaxTokens: number;
  preserveRecentTurns: number;
  systemPromptReserve: number;
  minContextBudget: number;
}

/** 摘要核心算法的最小消息形态：MessageInfo 与 ChatMessage 均结构兼容。 */
export type SummarizableMessage = { role: string; content: string };

export interface ContextCompressionEvent {
  type: "context.compression_start" | "context.compression_summary";
  data: Record<string, unknown>;
}

export interface ContextCompressionResult {
  status: "skipped" | "success";
  reason: string;
  budgetTokens: number;
  historyTokens: number;
  thresholdTokens: number;
  summaryMessage?: MessageInfo | undefined;
  replacedMessageCount: number;
  replacesUpToSeq: number | null;
}

export interface ForceContextCompressionResult {
  status: "skipped" | "success";
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
    private readonly modelProviders: RuntimeModelProviderPort,
  ) {}

  resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig, modelName: string | null): number {
    return resolveContextBudget(agent, provider, this.systemConfig.getConfig(), modelName);
  }

  resolveContextSettings(agent: AgentConfig): RuntimeContextSettings {
    return resolveRuntimeContextSettings(agent, this.systemConfig.getConfig());
  }

  async compressIfNeeded(input: CompressIfNeededInput): Promise<ContextCompressionResult> {
    const threadKey = input.threadKey?.trim() || "root";
    const settings = this.resolveContextSettings(input.agent);
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider, input.modelName);
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

    const summaryContent = await this.summarizeSegment({
      agent: input.agent,
      provider: input.provider,
      modelName: input.modelName,
      segment,
      existingSummary,
      maxTokens: settings.summarizeMaxTokens,
      signal: input.signal,
    });
    if (summaryContent === null) {
      // LLM 摘要不可用：跳过本轮压缩，保留完整历史等下轮重试，绝不做有损截断。
      return skipped("summary_unavailable", budgetTokens, historyTokens, thresholdTokens);
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
        compression_strategy: "llm_summarize",
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
        status: "success",
        reason: "success",
      },
    });

    return {
      status: "success",
      reason: "success",
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
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider, input.modelName);
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

    const summaryContent = await this.summarizeSegment({
      agent: input.agent,
      provider: input.provider,
      modelName: input.modelName,
      segment,
      existingSummary,
      maxTokens: settings.summarizeMaxTokens,
      signal: input.signal,
    });
    if (summaryContent === null) {
      // LLM 摘要不可用：强制压缩同样不做有损截断，如实回报未执行。
      return forceSkipped("summary_unavailable", rawMessages.length);
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
        compression_strategy: "llm_summarize",
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
        status: "success",
        reason: "success",
        forced: true,
      },
    });

    return {
      status: "success",
      reason: "success",
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
    segment: ReadonlyArray<SummarizableMessage>;
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

  /**
   * 摘要核心算法（与数据源无关）：对一段消息生成结构化摘要。
   * store 路径（compressIfNeeded / forceCompactSession）与内核内存路径（循环内压缩 hook）共享。
   * 摘要目标模型由 resolveSummaryTierCandidates 按 fast→default→系统 逐级解析去重；其中
   * default = 传入的 provider/modelName（运行已解析的模型，已含 selectedLlm 覆盖），
   * fast 未配置则回落到 default。前级失败（非 abort）自动降级到下一候选。
   * 压缩只走大模型摘要——全候选失败时返回 null（调用方据此跳过本轮压缩、保留完整历史
   * 等下轮重试），绝不做有损截断；abort 立即抛。
   */
  async summarizeSegment(input: {
    agent: AgentConfig;
    provider: ModelProviderConfig;
    modelName: string;
    segment: ReadonlyArray<SummarizableMessage>;
    existingSummary: string;
    maxTokens: number;
    signal?: AbortSignal | undefined;
  }): Promise<string | null> {
    const candidates = resolveSummaryTierCandidates(
      input.agent,
      { provider: input.provider, modelName: input.modelName },
      this.systemConfig.getConfig(),
      this.modelProviders.listProviders(),
    );
    for (const candidate of candidates) {
      try {
        return await this.generateSummary({
          agent: input.agent,
          provider: candidate.provider,
          modelName: candidate.modelName,
          segment: input.segment,
          existingSummary: input.existingSummary,
          maxTokens: input.maxTokens,
          signal: input.signal,
        });
      } catch (error) {
        if (input.signal?.aborted) {
          throw error;
        }
      }
    }
    return null;
  }
}

export interface SummaryTierCandidate {
  tier: string;
  provider: ModelProviderConfig;
  modelName: string;
}

/** default 层（= 运行已解析的模型，已含 selectedLlm 覆盖）。 */
export interface SummaryDefaultModel {
  provider: ModelProviderConfig;
  modelName: string;
}

/**
 * 解析摘要 LLM 的逐级候选：fast → default → 系统配置(systemConfig.llm)。
 *
 * tier 语义（与运行选模一致）：
 * - `default` 层 = 调用方传入的 `defaultModel`，即运行已解析的模型——selectedLlm
 *   覆盖 `llm_tiers.default` 后的结果。摘要恒以它为基准候选，故 selectedLlm-only
 *   的 agent 也能正常 LLM 压缩。
 * - `fast` 等其它层：`llm_tiers` 配了且能解析就用配置的；没配 / 解析失败则回落到
 *   `default`（去重后与 default 合并为一条）。
 * - `system`：仅在 `systemConfig.llm` 显式配置且可解析时作为最末兜底。
 *
 * 每条候选经 findProviderByRef 解析成完整 ModelProviderConfig，按
 * (provider key, provider_type, model_name) 三元组归一化去重——避免不同层指向
 * 同一模型时重复尝试。只解析"用哪个模型"，摘要长度由调用方以 summarizeMaxTokens 传入。
 */
export function resolveSummaryTierCandidates(
  agent: AgentConfig,
  defaultModel: SummaryDefaultModel,
  systemConfig: SystemConfigData,
  providers: ModelProviderConfig[],
): SummaryTierCandidate[] {
  const seen = new Set<string>();
  const candidates: SummaryTierCandidate[] = [];
  const tryPush = (candidate: SummaryTierCandidate | null): void => {
    if (!candidate) {
      return;
    }
    const key = summaryDedupKey(candidate);
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  const tiers = agent.llm_tiers ?? {};
  // fast：配了能解析就用配置的，否则回落到 default。
  tryPush(resolveTierWithDefault("fast", asRecord(tiers.fast), defaultModel, providers));
  // default：运行模型（已含 selectedLlm 覆盖），恒为基准候选。
  tryPush({ tier: "default", provider: defaultModel.provider, modelName: defaultModel.modelName });
  // system：仅在显式配置且可解析时加入。
  tryPush(resolveConfiguredCandidate("system", asRecord(systemConfig.llm), providers));
  return candidates;
}

/** tier 配了且可解析则返回配置候选；否则回落到 default。 */
function resolveTierWithDefault(
  tier: string,
  config: Record<string, unknown> | null,
  defaultModel: SummaryDefaultModel,
  providers: ModelProviderConfig[],
): SummaryTierCandidate {
  return (
    resolveConfiguredCandidate(tier, config, providers) ?? {
      tier,
      provider: defaultModel.provider,
      modelName: defaultModel.modelName,
    }
  );
}

/** 仅当 config 显式配置且能解析出 provider+model 时返回候选，否则 null。 */
function resolveConfiguredCandidate(
  tier: string,
  config: Record<string, unknown> | null,
  providers: ModelProviderConfig[],
): SummaryTierCandidate | null {
  if (!config) {
    return null;
  }
  const provider = findProviderByRef(providers, {
    provider: asNullableString(config.provider),
    provider_type: asNullableString(config.provider_type),
  });
  const modelName = asNullableString(config.model_name);
  if (!provider || !modelName) {
    return null;
  }
  return { tier, provider, modelName };
}

function summaryDedupKey(candidate: SummaryTierCandidate): string {
  const provider = candidate.provider;
  const providerKey = provider.key ?? `${provider.name}_${provider.provider_type}`;
  return [
    normalizeProviderKey(providerKey),
    normalizeProviderKey(provider.provider_type),
    normalizeProviderKey(candidate.modelName),
  ].join("|");
}

function asNullableString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
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
  modelName: string | null,
): number {
  const settings = resolveRuntimeContextSettings(agent, systemConfig);
  const systemLlmConfig = asRecord(systemConfig.llm) ?? {};
  const defaultLlm = agent.llm_tiers?.default;
  const contextWindow =
    positiveInt(provider?.max_context_tokens) ??
    positiveInt(defaultLlm?.max_context_tokens) ??
    positiveInt(systemLlmConfig.max_context_tokens);
  // 补全预留按"本次实际运行模型"取：与请求壳同一套真相来源（resolveRequestLlmParams），
  // 故 selectedLlm 选中其它模型时预留它自己的 max_completion_tokens；无具体运行模型
  // （provider/modelName 缺失，如 usage 预览/快照）时回落到默认层 → 系统 → 兜底常量。
  const runParams = provider && modelName ? resolveRequestLlmParams(agent, provider, modelName) : null;
  const maxCompletionTokens =
    positiveInt(runParams?.maxCompletionTokens) ??
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

function buildSummaryMessages(segment: ReadonlyArray<SummarizableMessage>, existingSummary: string): ChatMessage[] {
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
