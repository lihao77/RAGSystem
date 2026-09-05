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
 * 一切渠道共用的执行 Agent 解析（唯一状态判定点）：显式 agentName（请求指定 /
 * 目标 run 记录）优先，缺省回落会话入口 Agent；selectedLlm 覆盖 default 档
 * （null/空 = 无覆盖）。用户发送（sendUserMessage）与 mailbox 消费组件共用。
 */
export function resolveExecutionAgentFor(
  resolver: RuntimeExecutionConfigResolver,
  input: {
    agentName?: string | null;
    teamSnapshot: NonNullable<RuntimeCoreReadinessInput["teamSnapshot"]>;
    selectedLlm?: string | null;
  },
): ReadinessResolution {
  return resolveReadyAgent(resolver, {
    agentName: input.agentName?.trim() || input.teamSnapshot.entry_agent_name,
    teamSnapshot: input.teamSnapshot,
    ...(input.selectedLlm !== undefined ? { selectedLlm: input.selectedLlm } : {}),
  });
}

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
