/**
 * AgentContextCompressionService（设计稿 §9，简化迁入）。
 *
 * 与 backend-ts 的根本差异：tier 解析已在投影层算死（§3），SDK 内核零兜底——
 * - resolveContextBudget：调 llm-params/budget（纯算术），不查 systemConfig
 * - resolveContextCompressionSettings：读 profile.behavior（带默认）
 * - summarizeSegment：读 llm-params/summary-tier（fast→default），不查 systemConfig/modelProviders
 * - LLM 摘要直接用 profile.llmTiers 候选 + tier-params 参数，无 provider-lookup
 */
import type { LlmClient, LlmRequest, ChatMessage } from "@ragsystem/agent-llm";
import type { RuntimeStore } from "../contracts.js";
import type { MessageInfo, AgentProfile, CompressionBudgetConfig } from "../types.js";
import { resolveContextBudget } from "../llm-params/budget.js";
import { resolveSummaryTierCandidates } from "../llm-params/summary-tier.js";
import { readTierParams } from "../llm-params/tier-params.js";
import { DEFAULT_COMPRESSION_BUDGET } from "../types.js";
import { resolveCompressionView } from "../context/history-view.js";
import { countMessagesTokens } from "./token-estimate.js";

const COMPACT_SUMMARY_PREFIX = "本次会话从之前的对话继续，以下是该对话早期内容的摘要。\n\n";
const NO_TOOLS_PREAMBLE = "你正在生成上下文压缩摘要。不要调用工具，不要输出工具调用协议，只输出摘要文本。\n\n";
const NO_TOOLS_TRAILER = "\n\n再次提醒：不要调用工具，只输出 <summary> 中的摘要内容或纯文本摘要。";
const COMPACT_PROMPT_BODY = `<summary>
1. 主要目标：[用户要完成什么]
2. 已完成内容：[已经完成的关键工作]
3. 关键决策：[重要设计选择、约束、用户偏好]
4. 当前状态：[最后进展、运行状态、未完成事项]
5. 重要上下文：[文件、接口、配置、错误、命令结果等后续必须知道的信息]
6. 下一步：[建议继续做什么]
</summary>`;
const DEFAULT_HISTORY_SCAN_LIMIT = 10_000;

export interface ContextCompressionSettings {
  compressionTriggerRatio: number;
  summarizeMaxTokens: number;
  preserveRecentTurns: number;
  systemPromptReserve: number;
  minContextBudget: number;
}

export type SummarizableMessage = { role: string; content: string };

export interface ContextCompressionResult {
  status: "skipped" | "success";
  reason: string;
  budgetTokens: number;
  historyTokens: number;
  thresholdTokens: number;
  summaryMessage?: MessageInfo;
  replacedMessageCount: number;
  replacesUpToSeq: number | null;
}

export interface ContextCompressionDeps {
  store: RuntimeStore;
  llm: LlmClient;
  profile: AgentProfile;
  budget?: CompressionBudgetConfig;
}

/** 压缩门面：compressIfNeeded（阈值门控）+ forceCompact（手动）+ 共享 loadHistory。 */
export class AgentContextCompressionService {
  private readonly store: RuntimeStore;
  private readonly llm: LlmClient;
  private readonly profile: AgentProfile;
  private readonly budget: CompressionBudgetConfig;

  constructor(deps: ContextCompressionDeps) {
    this.store = deps.store;
    this.llm = deps.llm;
    this.profile = deps.profile;
    this.budget = deps.budget ?? deps.profile.behavior.budget ?? DEFAULT_COMPRESSION_BUDGET;
  }

  resolveContextBudget(): number {
    return resolveContextBudget(this.profile.llmTiers, this.budget);
  }

  resolveContextSettings(): ContextCompressionSettings {
    return resolveSettings(this.profile, this.budget);
  }

  async compressIfNeeded(input: CompressInput): Promise<ContextCompressionResult> {
    const loaded = this.loadCompressionHistory(input);
    const { threadKey, budgetTokens, historyTokens, settings } = loaded;
    const thresholdTokens = Math.floor(budgetTokens * settings.compressionTriggerRatio);
    if (historyTokens < thresholdTokens) {
      return skipped("below_threshold", budgetTokens, historyTokens, thresholdTokens);
    }
    const selected = selectCompressibleSegment(loaded.historyResolved, settings);
    if (!selected.ok) {
      return skipped(selected.reason, budgetTokens, historyTokens, thresholdTokens);
    }
    const summarizeArgs: { segment: MessageInfo[]; existingSummary: string; maxTokens: number; signal?: AbortSignal } = {
      segment: selected.segment,
      existingSummary: selected.existingSummary,
      maxTokens: settings.summarizeMaxTokens,
    };
    if (input.signal) {
      summarizeArgs.signal = input.signal;
    }
    const summaryContent = await this.summarizeSegment(summarizeArgs);
    if (summaryContent === null) {
      return skipped("summary_unavailable", budgetTokens, historyTokens, thresholdTokens);
    }
    const summaryMessage = this.store.runInTransaction((tx) =>
      tx.insertCompressionMessage({
        sessionId: input.sessionId,
        threadKey,
        content: summaryContent,
        replacesUpToSeq: selected.replacesUpToSeq,
        metadata: compressionMetadata(this.profile, input, selected.segment.length, historyTokens, thresholdTokens, budgetTokens, false),
      }),
    );
    return {
      status: "success",
      reason: "success",
      budgetTokens,
      historyTokens,
      thresholdTokens,
      summaryMessage,
      replacedMessageCount: selected.segment.length,
      replacesUpToSeq: selected.replacesUpToSeq,
    };
  }

  /**
   * 手动强制压缩（无阈值门控）：与 compressIfNeeded 共享 loadHistory/selectSegment/summarize/insert，
   * 仅去掉"historyTokens < threshold"那道闸。供 compactSession（外部 /compact）调用；
   * 幂等——loadCompressionView 已按压缩边界归并，已压缩区间不会重复压缩。
   */
  async forceCompact(input: CompressInput): Promise<ContextCompressionResult> {
    const loaded = this.loadCompressionHistory(input);
    const { threadKey, budgetTokens, historyTokens, settings } = loaded;
    const thresholdTokens = Math.floor(budgetTokens * settings.compressionTriggerRatio);
    const selected = selectCompressibleSegment(loaded.historyResolved, settings);
    if (!selected.ok) {
      return skipped(selected.reason, budgetTokens, historyTokens, thresholdTokens);
    }
    const summarizeArgs: { segment: MessageInfo[]; existingSummary: string; maxTokens: number; signal?: AbortSignal } = {
      segment: selected.segment,
      existingSummary: selected.existingSummary,
      maxTokens: settings.summarizeMaxTokens,
    };
    if (input.signal) {
      summarizeArgs.signal = input.signal;
    }
    const summaryContent = await this.summarizeSegment(summarizeArgs);
    if (summaryContent === null) {
      return skipped("summary_unavailable", budgetTokens, historyTokens, thresholdTokens);
    }
    const summaryMessage = this.store.runInTransaction((tx) =>
      tx.insertCompressionMessage({
        sessionId: input.sessionId,
        threadKey,
        content: summaryContent,
        replacesUpToSeq: selected.replacesUpToSeq,
        metadata: compressionMetadata(this.profile, input, selected.segment.length, historyTokens, thresholdTokens, budgetTokens, true),
      }),
    );
    return {
      status: "success",
      reason: "success",
      budgetTokens,
      historyTokens,
      thresholdTokens,
      summaryMessage,
      replacedMessageCount: selected.segment.length,
      replacesUpToSeq: selected.replacesUpToSeq,
    };
  }

  private loadCompressionHistory(input: { sessionId: string; threadKey?: string | null }): {
    threadKey: string;
    settings: ContextCompressionSettings;
    budgetTokens: number;
    rawMessageCount: number;
    historyResolved: MessageInfo[];
    historyTokens: number;
  } {
    const threadKey = input.threadKey?.trim() || "root";
    const settings = this.resolveContextSettings();
    const budgetTokens = this.resolveContextBudget();
    const rawMessages = this.store
      .listMessages(input.sessionId, threadKey, DEFAULT_HISTORY_SCAN_LIMIT)
      .filter(isCompressibleHistoryMessage);
    const historyResolved = resolveCompressionView(rawMessages);
    const historyTokens = countMessagesTokens(historyResolved);
    return { threadKey, settings, budgetTokens, rawMessageCount: rawMessages.length, historyResolved, historyTokens };
  }

  /**
   * 摘要核心：读 [tiers.fast, tiers.default] 去重候选（llm-params/summary-tier），
   * 逐候选用 tier-params 取生成参数调 LLM；前级失败（非 abort）降级；全失败返回 null（保留完整历史）。
   */
  async summarizeSegment(input: {
    segment: ReadonlyArray<SummarizableMessage>;
    existingSummary: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string | null> {
    const candidates = resolveSummaryTierCandidates(this.profile.llmTiers);
    for (const candidate of candidates) {
      const params = readTierParams(this.profile.llmTiers, candidate.tier);
      try {
        const genArgs: { provider: import("@ragsystem/agent-llm").ProviderConfig; modelName: string; params: import("@ragsystem/agent-llm").RequestLlmParams; segment: ReadonlyArray<SummarizableMessage>; existingSummary: string; maxTokens: number; signal?: AbortSignal } = {
          provider: candidate.provider,
          modelName: candidate.modelName,
          params,
          segment: input.segment,
          existingSummary: input.existingSummary,
          maxTokens: input.maxTokens,
        };
        if (input.signal) {
          genArgs.signal = input.signal;
        }
        return await this.generateSummary(genArgs);
      } catch (error) {
        if (input.signal?.aborted) {
          throw error;
        }
      }
    }
    return null;
  }

  private async generateSummary(input: {
    provider: import("@ragsystem/agent-llm").ProviderConfig;
    modelName: string;
    params: import("@ragsystem/agent-llm").RequestLlmParams;
    segment: ReadonlyArray<SummarizableMessage>;
    existingSummary: string;
    maxTokens: number;
    signal?: AbortSignal;
  }): Promise<string> {
    const request: LlmRequest = {
      messages: buildSummaryMessages(input.segment, input.existingSummary),
      model: input.modelName,
      provider: input.provider,
      temperature: input.params.temperature,
      maxCompletionTokens: Math.min(input.maxTokens, input.params.maxCompletionTokens ?? input.maxTokens),
      extraParams: input.params.extraParams,
    };
    if (input.signal) {
      request.signal = input.signal;
    }
    const response = await this.llm.complete(request);
    const summary = formatCompactResponse(response.content);
    if (!summary.trim()) {
      throw new Error("summary model returned empty content");
    }
    return summary;
  }
}

export interface CompressInput {
  sessionId: string;
  /** 自动路径必填（run 内）；手动路径（compactSession）无 run，可省。 */
  runId?: string;
  taskId?: string | null;
  requestId?: string | null;
  threadKey?: string | null;
  childAgentId?: string | null;
  signal?: AbortSignal;
}

function resolveSettings(profile: AgentProfile, budget: CompressionBudgetConfig): ContextCompressionSettings {
  const b = profile.behavior;
  return {
    compressionTriggerRatio: clamp(b.compressionTriggerRatio ?? 0.85, 0.5, 0.99),
    summarizeMaxTokens: positiveIntOrDefault(b.summarizeMaxTokens, 300),
    preserveRecentTurns: positiveIntOrDefault(b.preserveRecentTurns, 3),
    systemPromptReserve: budget.systemPromptReserve,
    minContextBudget: budget.minContextBudget,
  };
}

function compressionMetadata(
  profile: AgentProfile,
  input: CompressInput,
  replacedCount: number,
  historyTokens: number,
  thresholdTokens: number,
  budgetTokens: number,
  forced: boolean,
): Record<string, unknown> {
  return {
    agent: profile.agentName,
    run_id: input.runId,
    request_id: input.requestId,
    task_id: input.taskId,
    msg_type: "context_compression_summary",
    compression_strategy: "llm_summarize",
    replaced_message_count: replacedCount,
    history_tokens_before: historyTokens,
    threshold_tokens: thresholdTokens,
    budget_tokens: budgetTokens,
    ...(forced ? { forced: true } : {}),
  };
}

function buildSummaryMessages(segment: ReadonlyArray<SummarizableMessage>, existingSummary: string): ChatMessage[] {
  const existingSection = existingSummary.trim()
    ? `\n\n---已有历史摘要（将与新内容合并）---\n${existingSummary.trim()}\n---end---`
    : "";
  const conversationText =
    segment.map((m) => `${m.role}: ${m.content.trim()}`).filter((line) => line.trim()).join("\n") || "（无内容）";
  return [
    { role: "system", content: "你是一名专业的对话摘要助手。你的任务是将对话压缩为结构化摘要，以便后续会话继续进行。不要调用任何工具，只输出文本。" },
    { role: "user", content: `${NO_TOOLS_PREAMBLE}${COMPACT_PROMPT_BODY}${existingSection}\n\n---待压缩对话内容---\n${conversationText}\n---end---${NO_TOOLS_TRAILER}` },
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

type SegmentSelection =
  | { ok: true; segment: MessageInfo[]; replacesUpToSeq: number; existingSummary: string }
  | { ok: false; reason: "insufficient_candidates" | "missing_segment_seq" };

function selectCompressibleSegment(historyResolved: MessageInfo[], settings: ContextCompressionSettings): SegmentSelection {
  const startIndex = historyResolved[0]?.metadata.compression ? 1 : 0;
  const candidates = historyResolved.slice(startIndex);
  const preserveCount = settings.preserveRecentTurns * 2;
  if (candidates.length <= preserveCount) {
    return { ok: false, reason: "insufficient_candidates" };
  }
  const segment = preserveCount > 0 ? candidates.slice(0, candidates.length - preserveCount) : [...candidates];
  const replacesUpToSeq = lastPositiveSeq(segment);
  if (segment.length === 0 || replacesUpToSeq === null) {
    return { ok: false, reason: "missing_segment_seq" };
  }
  const existingSummary = startIndex === 1 ? historyResolved[0]?.content ?? "" : "";
  return { ok: true, segment, replacesUpToSeq, existingSummary };
}

function isCompressibleHistoryMessage(message: MessageInfo): boolean {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "tool" ||
 Boolean(message.metadata.compression)
  );
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

function skipped(reason: string, budgetTokens: number, historyTokens: number, thresholdTokens: number): ContextCompressionResult {
  return { status: "skipped", reason, budgetTokens, historyTokens, thresholdTokens, replacedMessageCount: 0, replacesUpToSeq: null };
}

function positiveIntOrDefault(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
