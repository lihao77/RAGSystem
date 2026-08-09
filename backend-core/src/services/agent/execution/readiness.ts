import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import type {
  RuntimeCoreReadinessInput,
  RuntimeExecutionConfigResolver,
} from "./runtime-core-service.js";
import { summarizeReadinessFailure } from "./helpers.js";

export type ReadinessResolution =
  | { ok: true; agent: AgentConfig; provider: ModelProviderConfig; modelName: string }
  | { ok: false; reason: string };

/**
 * 解析执行配置并在 runtime 就绪时返回 agent/provider/modelName。
 * Workspace 属于 Session 一等字段，由运行引擎单独解析，不从 metadata 覆盖 Agent。
 */
export function resolveReadyAgent(
  resolver: RuntimeExecutionConfigResolver,
  input: RuntimeCoreReadinessInput,
): ReadinessResolution {
  const resolved = resolver.resolveExecutionConfig(input);
  if (
    !resolved.readiness.configuration_ready ||
    !resolved.agent ||
    !resolved.provider ||
    !resolved.modelName
  ) {
    return { ok: false, reason: summarizeReadinessFailure(resolved.readiness.requirements) };
  }
  return {
    ok: true,
    agent: resolved.agent,
    provider: resolved.provider,
    modelName: resolved.modelName,
  };
}
