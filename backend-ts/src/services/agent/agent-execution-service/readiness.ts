import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type {
  RuntimeCoreReadinessInput,
  RuntimeExecutionConfigResolver,
} from "../../runtime/runtime-core-service.js";
import { applySessionAgentOverrides, summarizeReadinessFailure } from "./helpers.js";

export type ReadinessResolution =
  | { ok: true; agent: AgentConfig; provider: ModelProviderConfig; modelName: string }
  | { ok: false; reason: string };

/**
 * 解析执行配置并在 runtime 就绪时返回应用了 session 覆盖的 agent/provider/modelName。
 * 统一替换原 6 处 `resolveExecutionConfig` + readiness 判定 + `applySessionAgentOverrides` 重复。
 */
export function resolveReadyAgent(
  resolver: RuntimeExecutionConfigResolver,
  input: RuntimeCoreReadinessInput,
  sessionMetadata: Record<string, unknown>,
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
    agent: applySessionAgentOverrides(resolved.agent, sessionMetadata),
    provider: resolved.provider,
    modelName: resolved.modelName,
  };
}
