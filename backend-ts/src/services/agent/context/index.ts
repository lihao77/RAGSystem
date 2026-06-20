import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { ChatMessage } from "../../integrations/llm-chat-client.js";
import type { AgentPromptContext } from "../prompt-builder/index.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import {
  AgentContextCompressionService,
  resolveContextBudget,
  type ContextCompressionEvent,
  type ContextCompressionResult,
  type ForceContextCompressionResult,
  type RuntimeContextSettings,
} from "../context-compression/index.js";
import { AgentRuntimeContextBuilder, type AgentRuntimeContext } from "../context-builder/index.js";
import { buildContextUsagePayload } from "./usage.js";

/**
 * 上下文统一门面 —— 把"构建(含微压缩) → 算 usage/budget"收归一处；
 * LLM 摘要压缩由内核 beforeModel hook 驱动（见 runtime-compaction-hook.ts），
 * 不在 run 前置同步触发。调用方（run-engine / delegation / slash / monitoring）
 * 只问门面要上下文，不再各自拼装编排顺序。
 *
 * prepare：run 前置构建上下文 + 算 usage/budget，不压缩。
 * recompact：循环内自动压缩（compressIfNeeded + 重建），供 beforeModel hook 调用。
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
  promptContext: AgentPromptContext;
  threadKey?: string | null | undefined;
  historyLimit?: number | undefined;
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
    private readonly contextBuilder: AgentRuntimeContextBuilder,
    private readonly contextCompression: AgentContextCompressionService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig | null): number {
    return resolveContextBudget(agent, provider, this.systemConfig.getConfig());
  }

  /** run 前置上下文准备：构建(微压缩) + 算 usage/budget。压缩已下沉到内核 beforeModel hook。 */
  async prepare(input: PrepareContextInput): Promise<PreparedContext> {
    const threadKey = input.threadKey?.trim() || "root";
    const context = this.contextBuilder.buildContext({
      sessionId: input.sessionId,
      agent: input.agent,
      threadKey,
      ...(input.historyLimit !== undefined ? { historyLimit: input.historyLimit } : {}),
      microcompact: true,
    });
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider);
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

  resolveContextSettings(agent: AgentConfig): RuntimeContextSettings {
    return this.contextCompression.resolveContextSettings(agent);
  }

  /**
   * 循环内重压缩：复用 store 压缩(seq/落库正确)+ 重建上下文。
   * 返回重建后的会话；store 未触发压缩(skipped)时返回 null，调用方据此决定是否替换工作副本。
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
      return null;
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
    promptContext: AgentPromptContext;
    messages: ChatMessage[];
    round: number;
    runId: string;
    taskId: string | null;
    requestId: string;
    compressionResult?: ContextCompressionResult | null;
  }): Record<string, unknown> {
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider ?? null);
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
    historyLimit?: number | undefined;
  }): { context: AgentRuntimeContext; budgetTokens: number } {
    const context = this.contextBuilder.buildContext({
      sessionId: input.sessionId,
      agent: input.agent,
      ...(input.historyLimit !== undefined ? { historyLimit: input.historyLimit } : {}),
    });
    const budgetTokens = this.resolveContextBudget(input.agent, input.provider);
    return { context, budgetTokens };
  }

  /** /compact 显式强制压缩 store 历史，成功则重建上下文刷新 stable-prefix 缓存。 */
  async forceCompact(input: ForceCompactInput): Promise<ForceContextCompressionResult> {
    const result = await this.contextCompression.forceCompactSession(input);
    if (result.status === "success" || result.status === "fallback") {
      this.contextBuilder.buildContext({
        sessionId: input.sessionId,
        agent: input.agent,
        ...(input.threadKey ? { threadKey: input.threadKey } : {}),
        historyLimit: 0,
        forceMemoryPrefixRefresh: true,
      });
    }
    return result;
  }
}
