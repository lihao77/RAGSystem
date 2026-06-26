import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import { resolveContextBudget } from "../context-compression/index.js";
import { AgentContextBuilder, type AgentContext } from "../context-builder/index.js";

/**
 * 上下文门面 —— 仅供 monitoring 调试快照（snapshotContext + 预算估算）。
 * 压缩（自动 round.before / 手动 /compact）由 SDK 承担（compressIfNeeded / compactSession），本门面不参与。
 */
export class AgentContextService {
  constructor(
    private readonly contextBuilder: AgentContextBuilder,
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
}
