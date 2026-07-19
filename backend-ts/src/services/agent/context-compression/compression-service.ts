/**
 * Agent 压缩服务（自 SDK compression/context-compression.ts 迁入,A3 压缩外移）。
 *
 * 读 conversationStore 全量历史 → 压缩视图 → 阈值判断 → 选段 → agent-llm 摘要 → 写 compression 消息。
 * - 摘要 tier 候选/参数:SDK llm-params 纯函数（resolveSummaryTierCandidates/readTierParams,通用基金,不依赖 store）
 * - budget/settings:backend context-compression/index.ts（AgentConfig + systemConfig）
 * - 压缩视图:backend context/history-view（resolveCompressionView）
 * - LLM 调用:agent-llm OpenAiCompatibleClient（无状态,直接 new）
 *
 * run 内压缩（round.before 触发,compressIfNeeded）+ /compact（forceCompact）共用本服务。
 */
import { OpenAiCompatibleClient, extractText, type ChatMessage, type LlmClient, type LlmRequest } from "@ragsystem/agent-llm";
import { countMessagesTokens, readTierParams, resolveContextBudget, resolveSummaryTierCandidates } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import type { MessageInfo } from "../../../contracts/session.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import { HISTORY_SCAN_LIMIT, resolveCompressionView } from "../context/index.js";
import { projectAgentProfile } from "../sdk/projection.js";
import { resolveContextCompressionSettings, type ContextCompressionSettings } from "./index.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";

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

export interface CompressionResult {
  status: "skipped" | "success";
  reason: string;
  budgetTokens: number;
  historyTokens: number;
  thresholdTokens: number;
  summaryMessage?: MessageInfo;
  replacedMessageCount: number;
  replacesUpToSeq: number | null;
}

export interface CompressInput {
  agent: AgentConfig;
  sessionId: string;
  /** 自动路径必填（run 内）；手动路径（/compact）无 run,可省。 */
  runId?: string;
  taskId?: string | null;
  requestId?: string | null;
  threadKey?: string | null;
  childAgentId?: string | null;
  signal?: AbortSignal;
  /** 当前 system prompt token 数(含 memory prefix,base+tools)。budget = window×0.9 − 此值。调用方算好传入。 */
  systemPromptTokens: number;
}

export interface AsyncCompressionHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  insertCompressionMessage(input: {
    sessionId: string;
    summaryContent: string;
    replacesUpToSeq?: number | null;
    threadKey?: string;
    childAgentId?: string | null;
    metadata?: Record<string, unknown>;
  }): Promise<MessageInfo>;
}

interface LoadedHistory {
  profile: ReturnType<typeof projectAgentProfile>;
  settings: ContextCompressionSettings;
  budgetTokens: number;
  historyResolved: MessageInfo[];
  historyTokens: number;
  threadKey: string;
}

export class AgentCompressionService {
  private readonly llm: LlmClient;

  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly providersProvider: () => ModelProviderConfig[],
    private readonly systemConfig: SystemConfigService,
    llm?: LlmClient,
    private readonly asyncHistory?: AsyncCompressionHistoryPort,
  ) {
    this.llm = llm ?? new OpenAiCompatibleClient();
  }

  /** 阈值门控压缩（run 内 round.before 触发）。 */
  async compressIfNeeded(input: CompressInput): Promise<CompressionResult> {
    const loaded = await this.loadHistory(input);
    const thresholdTokens = Math.floor(loaded.budgetTokens * loaded.settings.compressionTriggerRatio);
    if (loaded.historyTokens < thresholdTokens) {
      return skipped("below_threshold", loaded.budgetTokens, loaded.historyTokens, thresholdTokens);
    }
    return this.runCompact(input, loaded, thresholdTokens, false);
  }

  /** 手动强制压缩（/compact,无阈值门控）。幂等——压缩视图已归并,已压缩区间不重复压。 */
  async forceCompact(input: CompressInput): Promise<CompressionResult> {
    const loaded = await this.loadHistory(input);
    const thresholdTokens = Math.floor(loaded.budgetTokens * loaded.settings.compressionTriggerRatio);
    return this.runCompact(input, loaded, thresholdTokens, true);
  }

  private async runCompact(
    input: CompressInput,
    loaded: LoadedHistory,
    thresholdTokens: number,
    forced: boolean,
  ): Promise<CompressionResult> {
    const selected = selectCompressibleSegment(loaded.historyResolved, loaded.settings);
    if (!selected.ok) {
      return skipped(selected.reason, loaded.budgetTokens, loaded.historyTokens, thresholdTokens);
    }
    const summaryContent = await this.summarizeSegment(
      selected.segment,
      selected.existingSummary,
      loaded.profile,
      loaded.settings.summarizeMaxTokens,
      input.signal,
    );
    if (summaryContent === null) {
      return skipped("summary_unavailable", loaded.budgetTokens, loaded.historyTokens, thresholdTokens);
    }
    const compressionInput = {
      sessionId: input.sessionId,
      summaryContent,
      replacesUpToSeq: selected.replacesUpToSeq,
      threadKey: loaded.threadKey,
      ...(input.childAgentId !== undefined && input.childAgentId !== null ? { childAgentId: input.childAgentId } : {}),
      metadata: compressionMetadata(input, selected.segment.length, loaded.historyTokens, thresholdTokens, loaded.budgetTokens, forced),
    };
    const summaryMessage = this.asyncHistory
      ? await this.asyncHistory.insertCompressionMessage(compressionInput)
      : this.conversationStore.insertCompressionMessage(compressionInput);
    return {
      status: "success",
      reason: "success",
      budgetTokens: loaded.budgetTokens,
      historyTokens: loaded.historyTokens,
      thresholdTokens,
      summaryMessage,
      replacedMessageCount: selected.segment.length,
      replacesUpToSeq: selected.replacesUpToSeq,
    };
  }

  private async loadHistory(input: CompressInput): Promise<LoadedHistory> {
    const threadKey = input.threadKey?.trim() || "root";
    const profile = projectAgentProfile({ agent: input.agent, providers: this.providersProvider() });
    const settings = resolveContextCompressionSettings(input.agent, this.systemConfig.getConfig());
    const budgetTokens = resolveContextBudget(profile.llmTiers, input.systemPromptTokens, profile.behavior.budget);
    const persistedMessages = this.asyncHistory
      ? await this.asyncHistory.getRecentMessages(input.sessionId, HISTORY_SCAN_LIMIT, threadKey)
      : this.conversationStore.getRecentMessages(input.sessionId, HISTORY_SCAN_LIMIT, threadKey);
    const rawMessages = persistedMessages.filter(isCompressibleHistoryMessage);
    const historyResolved = resolveCompressionView(rawMessages);
    const historyTokens = countMessagesTokens(historyResolved);
    return { profile, settings, budgetTokens, historyResolved, historyTokens, threadKey };
  }

  /**
   * 摘要核心:读 [tiers.fast, tiers.default] 去重候选,逐候选用 readTierParams 取参调 LLM;
   * 前级失败(非 abort)降级;全失败返回 null(保留完整历史,不做有损截断)。
   */
  private async summarizeSegment(
    segment: ReadonlyArray<MessageInfo>,
    existingSummary: string,
    profile: LoadedHistory["profile"],
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const candidates = resolveSummaryTierCandidates(profile.llmTiers);
    for (const candidate of candidates) {
      const params = readTierParams(profile.llmTiers, candidate.tier);
      try {
        return await this.generateSummary(candidate, params, segment, existingSummary, maxTokens, signal);
      } catch (error) {
        if (signal?.aborted) {
          throw error;
        }
      }
    }
    return null;
  }

  private async generateSummary(
    candidate: ReturnType<typeof resolveSummaryTierCandidates>[number],
    params: ReturnType<typeof readTierParams>,
    segment: ReadonlyArray<MessageInfo>,
    existingSummary: string,
    maxTokens: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const request: LlmRequest = {
      messages: buildSummaryMessages(segment, existingSummary),
      model: candidate.modelName,
      provider: candidate.provider,
      temperature: params.temperature,
      maxCompletionTokens: Math.min(maxTokens, params.maxCompletionTokens ?? maxTokens),
      extraParams: params.extraParams,
    };
    if (signal) {
      request.signal = signal;
    }
    const response = await this.llm.complete(request);
    const summary = formatCompactResponse(response.content);
    if (!summary.trim()) {
      throw new Error("summary model returned empty content");
    }
    return summary;
  }
}

type SegmentSelection =
  | { ok: true; segment: MessageInfo[]; replacesUpToSeq: number; existingSummary: string }
  | { ok: false; reason: "insufficient_candidates" | "missing_segment_seq" };

function selectCompressibleSegment(historyResolved: MessageInfo[], settings: ContextCompressionSettings): SegmentSelection {
  const startIndex = historyResolved[0]?.metadata.msg_type === MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY ? 1 : 0;
  const candidates = historyResolved.slice(startIndex);
  const preserveCount = settings.preserveRecentTurns * 2;
  if (candidates.length <= preserveCount) {
    return { ok: false, reason: "insufficient_candidates" };
  }
  let segment = preserveCount > 0 ? candidates.slice(0, candidates.length - preserveCount) : [...candidates];
  // 配对边界对齐:segment 末若是 assistant tool_use(其 tool_result 落在保留区),排除该 tool_use,避免摘要 tool_use 而保留 tool_result 造成孤立 observation(Anthropic tool_result without preceding tool_use)。
  while (segment.length > 0) {
    const last = segment[segment.length - 1];
    if (!last) {
      break;
    }
    if (last.role === "assistant" && last.tool_calls && last.tool_calls.length > 0) {
      segment = segment.slice(0, -1);
    } else {
      break;
    }
  }
  const replacesUpToSeq = lastPositiveSeq(segment);
  if (segment.length === 0 || replacesUpToSeq === null) {
    return { ok: false, reason: "missing_segment_seq" };
  }
  const existingSummary = startIndex === 1 ? extractText(historyResolved[0]?.content ?? "") : "";
  return { ok: true, segment, replacesUpToSeq, existingSummary };
}

function isCompressibleHistoryMessage(message: MessageInfo): boolean {
  return (
    message.role === "user" ||
    message.role === "assistant" ||
    message.role === "tool" ||
    Boolean(message.metadata.msg_type === MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY)
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

function compressionMetadata(
  input: CompressInput,
  replacedCount: number,
  historyTokens: number,
  thresholdTokens: number,
  budgetTokens: number,
  forced: boolean,
): Record<string, unknown> {
  return {
    agent: input.agent.agent_name,
    run_id: input.runId,
    request_id: input.requestId,
    task_id: input.taskId,
    msg_type: MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY,
    compression_strategy: "llm_summarize",
    replaced_message_count: replacedCount,
    history_tokens_before: historyTokens,
    threshold_tokens: thresholdTokens,
    budget_tokens: budgetTokens,
    ...(forced ? { forced: true } : {}),
  };
}

function buildSummaryMessages(segment: ReadonlyArray<MessageInfo>, existingSummary: string): ChatMessage[] {
  const existingSection = existingSummary.trim()
    ? `\n\n---已有历史摘要（将与新内容合并）---\n${existingSummary.trim()}\n---end---`
    : "";
  const conversationText =
    segment.map((m) => `${m.role}: ${extractText(m.content).trim()}`).filter((line) => line.trim()).join("\n") || "（无内容）";
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

function skipped(reason: string, budgetTokens: number, historyTokens: number, thresholdTokens: number): CompressionResult {
  return { status: "skipped", reason, budgetTokens, historyTokens, thresholdTokens, replacedMessageCount: 0, replacesUpToSeq: null };
}
