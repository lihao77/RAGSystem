import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import type { AgentPromptContext } from "../prompt-builder/index.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import {
  AgentContextCompressionService,
  estimateTokens,
  resolveContextBudget,
  type ContextCompressionEvent,
  type ContextCompressionResult,
  type ForceContextCompressionResult,
  type ContextCompressionSettings,
} from "../context-compression/index.js";
import { AgentContextBuilder, type AgentContext } from "../context-builder/index.js";
import { buildContextUsagePayload } from "./usage.js";

/**
 * 上下文统一门面 —— 把"构建(含微压缩) → 算 usage/budget"收归一处；
 * 执行链的 LLM 摘要压缩由 SDK 运行时内核承担，本门面不参与执行链压缩；
 * 仅供 /compact 手动压缩与 monitoring 调试快照。调用方（delegation / slash / monitoring）
 * 只问门面要上下文，不再各自拼装编排顺序。
 *
 * prepare：run 前置构建上下文 + 算 usage/budget，不压缩。
 * recompact：循环内 micro-first 重建（先 microcompact 廉价裁剪 → 按裁剪后 token 重判 →
 *   仅当仍超阈值才 LLM 压缩 + 重建），供 beforeModel hook 调用。
 * forceCompact：/compact 手动强制压缩 store 历史。
 */
export interface PreparedContext {
  conversation: ChatMessage[];
  stablePrefixFingerprint: string | null;
  budgetTokens: number;
  usage: Record<string, unknown>;
}

export interface PrepareContextInput {
  sessionId: string;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName?: string | null | undefined;
  promptContext: AgentPromptContext;
  threadKey?: string | null | undefined;
  round: number;
  runId: string;
  taskId: string | null;
  requestId: string | null;
}

export interface ForceCompactInput {
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
}

export class AgentContextService {
  constructor(
    private readonly contextBuilder: AgentContextBuilder,
    private readonly contextCompression: AgentContextCompressionService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /** systemConfig.llm 作为请求参数三级 fallback 的系统兜底（供 run-engine 注入 protocol）。 */
  getSystemLlm(): Record<string, unknown> | null {
    const llm = this.systemConfig.getConfig().llm as unknown;
    return typeof llm === "object" && llm !== null ? (llm as Record<string, unknown>) : null;
  }

  resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig | null, modelName: string | null): number {
    return resolveContextBudget(agent, provider, this.systemConfig.getConfig(), modelName);
  }

  /** run 前置上下文准备：构建(微压缩) + 算 usage/budget。压缩已下沉到内核 beforeModel hook。 */
  async prepare(input: PrepareContextInput): Promise<PreparedContext> {
    const threadKey = input.threadKey?.trim() || "root";
    const context = this.contextBuilder.buildContext({
      sessionId: input.sessionId,
      agent: input.agent,
      threadKey,
      microcompact: true,
    });
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider, input.modelName ?? null);
    const usage = buildContextUsagePayload({
      agent: input.agent,
      provider: input.provider,
      promptContext: input.promptContext,
      budgetTokens,
      messages: context.conversation,
      round: input.round,
      runId: input.runId,
      taskId: input.taskId ?? "",
      requestId: input.requestId ?? "",
    });
    return {
      conversation: context.conversation,
      stablePrefixFingerprint: context.metadata.stable_prefix_fingerprint,
      budgetTokens,
      usage,
    };
  }

  resolveContextSettings(agent: AgentConfig): ContextCompressionSettings {
    return this.contextCompression.resolveContextSettings(agent);
  }

  /**
   * 循环内 micro-first 重建（对齐 Python pipeline 的 microcompact→重判→压缩顺序）：
   * ① 先 microcompact 廉价裁剪旧 observation（不强刷 memory 前缀，保 KV 缓存）；
   * ② 按裁剪后 token 重判，未超阈值则直接返回（不触发 LLM 压缩）；
   * ③ 仍超阈值才走 compressIfNeeded（落 store）+ 重建（强刷 memory 前缀）。
   * 返回需替换工作副本的会话；无裁剪且未压缩时返回 null，调用方据此决定是否替换。
   */
  async recompact(input: {
    sessionId: string;
    agent: AgentConfig;
    provider: ModelProviderConfig;
    modelName: string;
    runId: string;
    taskId: string | null;
    requestId: string | null;
    threadKey?: string | null | undefined;
    childAgentId?: string | null | undefined;
    signal?: AbortSignal | undefined;
    onCompressionEvent?: ((event: ContextCompressionEvent) => void | Promise<void>) | undefined;
  }): Promise<ChatMessage[] | null> {
    const threadKey = input.threadKey?.trim() || "root";
    const settings = this.resolveContextSettings(input.agent);
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider, input.modelName);
    const thresholdTokens = Math.floor(budgetTokens * settings.compressionTriggerRatio);

    // ① 廉价：先 microcompact 重建（不强刷 memory 前缀，避免无谓打掉 KV 缓存）
    const micro = this.contextBuilder.buildContext({
      sessionId: input.sessionId,
      agent: input.agent,
      threadKey,
      microcompact: true,
    });
    const microApplied = readMicrocompactApplied(micro);
    const microTokens = micro.conversation.reduce((total, message) => total + estimateTokens(message.content), 0);

    // ② 裁剪后已达标 → 不做 LLM 压缩；仅当真有裁剪才回传替换工作副本
    if (microTokens < thresholdTokens) {
      return microApplied ? micro.conversation : null;
    }

    // ③ 仍超阈值 → LLM 压缩（落 store），成功则重建（强刷 memory 前缀）
    const compressionResult = await this.contextCompression.compressIfNeeded({
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId ?? "",
      requestId: input.requestId ?? "",
      agent: input.agent,
      provider: input.provider,
      modelName: input.modelName,
      threadKey,
      childAgentId: input.childAgentId ?? null,
      signal: input.signal,
      onEvent: input.onCompressionEvent,
    });
    if (compressionResult.status === "skipped") {
      // 压缩做不了（候选不足等）：退回 microcompact 视图（若有裁剪），否则不替换
      return microApplied ? micro.conversation : null;
    }
    const context = this.contextBuilder.buildContext({
      sessionId: input.sessionId,
      agent: input.agent,
      threadKey,
      microcompact: true,
      forceMemoryPrefixRefresh: true,
    });
    return context.conversation;
  }



  /** 仅计算 context.usage payload（外部已提供上下文、无需压缩/构建时用）。 */
  buildUsage(input: {
    agent: AgentConfig;
    provider?: ModelProviderConfig | null;
    modelName?: string | null | undefined;
    promptContext: AgentPromptContext;
    messages: ChatMessage[];
    round: number;
    runId: string;
    taskId: string | null;
    requestId: string;
    compressionResult?: ContextCompressionResult | null;
  }): Record<string, unknown> {
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider ?? null, input.modelName ?? null);
    return buildContextUsagePayload({
      agent: input.agent,
      provider: input.provider ?? null,
      promptContext: input.promptContext,
      budgetTokens,
      messages: input.messages,
      round: input.round,
      runId: input.runId,
      taskId: input.taskId ?? "",
      requestId: input.requestId,
      compressionResult: input.compressionResult ?? null,
    });
  }

  /** 只读上下文快照（不压缩、不写库），供 monitoring 端点。 */
  snapshotContext(input: {
    sessionId: string;
    agent: AgentConfig;
    provider: ModelProviderConfig | null;
    modelName?: string | null | undefined;
  }): { context: AgentContext; budgetTokens: number } {
    const context = this.contextBuilder.buildContext({
      sessionId: input.sessionId,
      agent: input.agent,
    });
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider, input.modelName ?? null);
    return { context, budgetTokens };
  }

  /** /compact 显式强制压缩 store 历史，成功则重建上下文刷新 stable-prefix 缓存。 */
  async forceCompact(input: ForceCompactInput): Promise<ForceContextCompressionResult> {
    const result = await this.contextCompression.forceCompactSession(input);
    if (result.status === "success") {
      this.contextBuilder.buildContext({
        sessionId: input.sessionId,
        agent: input.agent,
        ...(input.threadKey ? { threadKey: input.threadKey } : {}),
        forceMemoryPrefixRefresh: true,
      });
    }
    return result;
  }
}

/**
 * 判断本次 buildContext 是否真正裁剪了 observation（recent_messages source 的
 * microcompact.cleared_count > 0）。门控判定缓存鲜活/未启用时 cleared_count=0，视为未裁剪。
 */
function readMicrocompactApplied(context: AgentContext): boolean {
  const source = context.metadata.sources.find((entry) => entry.name === "recent_messages");
  const microcompact = source?.metadata?.microcompact;
  if (!microcompact || typeof microcompact !== "object") {
    return false;
  }
  const clearedCount = (microcompact as { cleared_count?: unknown }).cleared_count;
  return typeof clearedCount === "number" && clearedCount > 0;
}
