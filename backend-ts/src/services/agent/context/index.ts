import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { SystemConfigService } from "../../config/system-config-service.js";
import { resolveContextBudget } from "../context-compression/index.js";

/**
 * 上下文预算门面 —— 仅供 monitoring 调试快照的预算估算。
 *
 * 上下文组装（memory + recent sources）由 createRuntime 经 extraContextSources 注入（memory 归
 * services/agent/memory/，recent 由 SDK 内核），压缩由 SDK 承担。本门面不再组装 context——
 * 旧 snapshotContext 是 run/preview 收敛前的平行组装残留，随 memory 迁出一并删除。
 */
export class AgentContextService {
  constructor(private readonly systemConfig: SystemConfigService) {}

  resolveContextBudget(agent: AgentConfig, provider: ModelProviderConfig | null, modelName: string | null): number {
    return resolveContextBudget(agent, provider, this.systemConfig.getConfig(), modelName);
  }
}
