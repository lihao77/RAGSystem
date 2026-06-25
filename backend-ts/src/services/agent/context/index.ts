import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import {
  AgentContextCompressionService,
  resolveContextBudget,
  type ContextCompressionEvent,
  type ForceContextCompressionResult,
} from "../context-compression/index.js";
import { AgentContextBuilder, type AgentContext } from "../context-builder/index.js";

/**
 * 上下文统一门面 —— 仅供 /compact 手动压缩与 monitoring 调试快照。
 * 执行链的 LLM 摘要压缩由 SDK 运行时内核（compaction-hook）承担，本门面不参与执行链压缩。
 */
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

  resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig | null, modelName: string | null): number {
    return resolveContextBudget(agent, provider, this.systemConfig.getConfig(), modelName);
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
