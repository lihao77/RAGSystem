/**
 * Agent 压缩服务（自 SDK compression/context-compression.ts 迁入,A3 压缩外移）。
 *
 * 读 history port 全量历史 → 压缩视图 → 阈值判断 → 选段 → agent-llm 摘要 → 写 compression 消息。
 * - 摘要 tier 候选/参数:SDK llm-params 纯函数（resolveSummaryTierCandidates/readTierParams,通用基金,不依赖 store）
 * - budget/settings:backend context-compression/index.ts（AgentConfig + systemConfig）
 * - 压缩视图:backend context/history-view（resolveCompressionView）
 * - LLM 调用:agent-llm LlmProviderClient（无状态,直接 new）
 *
 * run 内压缩（round.before 触发,compressIfNeeded）+ /compact（forceCompact）共用本服务。
 */
import { LlmProviderClient, extractText, type ChatMessage, type LlmClient, type LlmRequest } from "@ragsystem/agent-llm";
import { countMessagesTokens, estimateMessageTokens, readTierParams, resolveContextBudget, resolveSummaryTierCandidates } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import type { CompressionHistoryPort } from "../../../contracts/runtime/core-runtime-ports.js";
import type { MessageInfo } from "../../../contracts/session/session.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import { HISTORY_SCAN_LIMIT, resolveCompressionView } from "../context/index.js";
import { hasAgentVisibleMessageContent } from "../context/message-content-projector.js";
import { projectAgentProfile } from "../sdk/projection.js";
import { resolveContextCompressionSettings, normalizePreserveTokenBudgets, type ContextCompressionSettings } from "./index.js";
import { MSG_TYPE } from "../../../contracts/message-kinds.js";

// 桥接文案即叙事锚点:告知模型"开头是摘要(被告知的情况),之后是正在发生的现场(未压缩原文,不重叠)"。
const COMPACT_SUMMARY_PREFIX = "本次会话从之前的对话继续，以下是该对话早期内容的摘要。摘要之后是最近未压缩的原始对话，与摘要内容不重叠。\n\n";
// 输出格式三处统一为"<summary> 块"（formatCompactResponse 优先解析 <summary>，纯文本仅作解析兜底）。
const NO_TOOLS_PREAMBLE = "你正在生成上下文压缩摘要。不要调用工具，不要输出工具调用协议。\n\n";
const NO_TOOLS_TRAILER = "\n\n再次提醒：不要调用工具；只输出一个 <summary>…</summary> 块，不要输出其他内容。";
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
  /** 当前 system prompt token 数（含注入上下文、base 和 tools）。budget = window×0.9 − 此值。调用方算好传入。 */
  systemPromptTokens: number;
  /** 上一轮 provider 实测输入 token + 当前新增消息的校准估算；有值时优先用于阈值判断。 */
  providerAdjustedInputTokens?: number;
}

interface LoadedHistory {
  profile: ReturnType<typeof projectAgentProfile>;
  settings: ContextCompressionSettings;
  budgetTokens: number;
  historyResolved: MessageInfo[];
  historyTokens: number;
  estimatedHistoryTokens: number;
  threadKey: string;
}

export class AgentCompressionService {
  private readonly llm: LlmClient;

  constructor(
    private readonly history: CompressionHistoryPort,
    private readonly providersProvider: () => ModelProviderConfig[],
    private readonly systemConfig: SystemConfigService,
    llm?: LlmClient,
  ) {
    this.llm = llm ?? new LlmProviderClient();
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
      metadata: compressionMetadata(
        input,
        selected.segment.length,
        loaded.historyTokens,
        loaded.estimatedHistoryTokens,
        thresholdTokens,
        loaded.budgetTokens,
        forced,
      ),
    };
    const summaryMessage = await this.history.insertCompressionMessage(compressionInput);
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
    const rawSettings = resolveContextCompressionSettings(input.agent, this.systemConfig.getConfig());
    const budgetTokens = resolveContextBudget(profile.llmTiers, input.systemPromptTokens);
    // 保留区 token 预算钳到实际历史预算:兜底小窗下默认值会让选段 missing_segment_seq、压缩永久失效。
    const settings: ContextCompressionSettings = {
      ...rawSettings,
      ...normalizePreserveTokenBudgets(rawSettings.preserveMinTokens, rawSettings.preserveMaxTokens, budgetTokens),
    };
    const persistedMessages = await this.history.getRecentMessages(input.sessionId, HISTORY_SCAN_LIMIT, threadKey);
    const rawMessages = persistedMessages.filter(isCompressibleHistoryMessage);
    const historyResolved = resolveCompressionView(rawMessages);
    const estimatedHistoryTokens = countMessagesTokens(historyResolved);
    const historyTokens = resolveEffectiveHistoryTokens(
      estimatedHistoryTokens,
      input.systemPromptTokens,
      input.providerAdjustedInputTokens,
    );
    return { profile, settings, budgetTokens, historyResolved, historyTokens, estimatedHistoryTokens, threadKey };
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

/** 选段纯函数（导出供单测直接断言边界对齐）。 */
export function selectCompressibleSegment(historyResolved: MessageInfo[], settings: ContextCompressionSettings): SegmentSelection {
  const startIndex = historyResolved[0]?.metadata.msg_type === MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY ? 1 : 0;
  const candidates = historyResolved.slice(startIndex);
  const minPreserveCount = settings.preserveRecentTurns * 2;
  if (candidates.length <= minPreserveCount) {
    return { ok: false, reason: "insufficient_candidates" };
  }
  const boundary = selectPreserveBoundary(candidates, settings);
  const segment = candidates.slice(0, boundary);
  const replacesUpToSeq = lastPositiveSeq(segment);
  if (segment.length === 0 || replacesUpToSeq === null) {
    return { ok: false, reason: "missing_segment_seq" };
  }
  const existingSummary = startIndex === 1 ? extractText(historyResolved[0]?.content ?? "") : "";
  return { ok: true, segment, replacesUpToSeq, existingSummary };
}

/**
 * 保留区起点（token 预算制）：从尾部向前累计，至少保留 preserveRecentTurns×2 条且不低于
 * preserveMinTokens，上限 preserveMaxTokens（单条超限也只能整条保留）。条数下限保叙事完整；
 * token 上下限防"6 条只有几百 token 断叙"与"6 条巨型工具结果白压"两个极端。
 * 锚点内收(user)→ 配对对齐(段尾悬空 tool_use / 保留区首条 tool 结果)在同一函数内完成。
 */
function selectPreserveBoundary(candidates: MessageInfo[], settings: ContextCompressionSettings): number {
  const minMessages = settings.preserveRecentTurns * 2;
  let boundary = candidates.length;
  let kept = 0;
  let tokens = 0;
  while (boundary > 0) {
    if (kept >= minMessages && tokens >= settings.preserveMinTokens) break;
    const message = candidates[boundary - 1];
    if (!message) break;
    tokens += estimateMessageTokens(message);
    boundary -= 1;
    kept += 1;
    // token 上限不突破条数下限:保留区先保叙事完整(minMessages),再受预算约束。
    if (kept >= minMessages && tokens >= settings.preserveMaxTokens) break;
  }
  return alignSegmentBoundary(candidates, preferUserMessageStart(candidates, boundary, settings));
}

/**
 * 配对边界对齐:压缩段不得以"悬空 tool_use"(assistant 带 tool_calls 且其结果全部落在保留区)结尾,
 * 也不得横切 tool 结果序列——保留区首条若是 tool,其 tool_use 必在段内被摘要,构成孤立
 * observation(OpenAI 400 / Anthropic tool_result without preceding tool_use)。缓冲型 follow-up
 * 穿插(user 消息夹在 tool_use 与结果之间)由前一条规则覆盖:段尾悬空 intent 即回退。
 * 仅检查段尾与保留区首条:同一事务的 intent 恒在其 tool 结果之前,两处成立则段内必然配对。
 */
function alignSegmentBoundary(candidates: MessageInfo[], boundary: number): number {
  let aligned = Math.min(Math.max(0, boundary), candidates.length);
  while (aligned > 0) {
    const segmentTail = candidates[aligned - 1];
    const keptHead = candidates[aligned];
    const tailIsDanglingToolUse = segmentTail?.role === "assistant" && (segmentTail.tool_calls?.length ?? 0) > 0;
    const keptHeadIsToolResult = keptHead?.role === "tool";
    if (!tailIsDanglingToolUse && !keptHeadIsToolResult) break;
    aligned -= 1;
  }
  return aligned;
}

/**
 * 叙事锚点对齐:保留区尽量以 user 消息开头。模型没有"保留区"概念,压缩后的序列应读作
 * "交接摘要 + 一段有头的近期对话";首条是没头没尾的 assistant 轮会让模型自行幻觉前因。
 * 内收上限 preserveMaxTokens——子智能体长工具链里两条 user 消息可能相隔上百条,
 * 超预算即放弃,接受事务对齐边界。
 */
function preferUserMessageStart(candidates: MessageInfo[], boundary: number, settings: ContextCompressionSettings): number {
  if (boundary <= 0 || boundary >= candidates.length) return boundary;
  if (candidates[boundary]?.role === "user") return boundary;
  let tokens = countMessagesTokens(candidates.slice(boundary));
  let walked = boundary;
  while (walked > 0) {
    const previous = candidates[walked - 1];
    if (!previous) break;
    const nextTokens = tokens + estimateMessageTokens(previous);
    // 内收含 user 锚点本身都受上限约束:短历史锚点可能就在段首,无约束会把整段掏空。
    if (nextTokens > settings.preserveMaxTokens) return boundary;
    if (previous.role === "user") return walked - 1;
    tokens = nextTokens;
    walked -= 1;
  }
  return boundary;
}

function isCompressibleHistoryMessage(message: MessageInfo): boolean {
  if (message.metadata.msg_type === MSG_TYPE.CONTEXT_COMPRESSION_SUMMARY) return true;
  if (message.role !== "user" && message.role !== "assistant" && message.role !== "tool") return false;
  return hasAgentVisibleMessageContent(message.content_parts, message.role)
    || Boolean(message.role === "assistant" && message.tool_calls?.length);
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
  estimatedHistoryTokens: number,
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
    estimated_history_tokens_before: estimatedHistoryTokens,
    token_count_source: input.providerAdjustedInputTokens !== undefined ? "provider_adjusted" : "estimate",
    ...(input.providerAdjustedInputTokens !== undefined
      ? { provider_adjusted_input_tokens: Math.floor(input.providerAdjustedInputTokens) }
      : {}),
    threshold_tokens: thresholdTokens,
    budget_tokens: budgetTokens,
    ...(forced ? { forced: true } : {}),
  };
}

export function resolveEffectiveHistoryTokens(
  estimatedHistoryTokens: number,
  systemPromptTokens: number,
  providerAdjustedInputTokens?: number,
): number {
  if (providerAdjustedInputTokens === undefined || !Number.isFinite(providerAdjustedInputTokens)) {
    return estimatedHistoryTokens;
  }
  return Math.max(0, Math.floor(providerAdjustedInputTokens) - Math.max(0, Math.floor(systemPromptTokens)));
}

function buildSummaryMessages(segment: ReadonlyArray<MessageInfo>, existingSummary: string): ChatMessage[] {
  const existingSection = existingSummary.trim()
    ? `\n\n---已有历史摘要（将与新内容合并）---\n${existingSummary.trim()}\n---end---`
    : "";
  const conversationText =
    segment.map((m) => `${m.role}: ${extractText(m.content).trim()}`).filter((line) => line.trim()).join("\n") || "（无内容）";
  return [
    { role: "system", content: "你是一名专业的对话摘要助手。你的任务是将对话压缩为结构化摘要，以便后续会话继续进行。不要调用任何工具；只输出一个 <summary>…</summary> 块。" },
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
