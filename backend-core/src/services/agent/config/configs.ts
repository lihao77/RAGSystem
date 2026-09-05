import { isRecord } from "../../../utils/guards.js";
export { isRecord };
import type { AgentConfig, AgentInfo, CreateAgentRequest } from "../../../contracts/agent/agent-config.js";
import {
  assertCreatableTeamName,
  cloneConfig,
  cloneConfigMap,
  configsToRecord,
  normalizeConfig,
  normalizeTeamName,
} from "../../../contracts/agent/config-normalize.js";
import type { AgentConfigTeam } from "../../../contracts/agent/team-store.js";

export type TeamConfigs = AgentConfigTeam;
export {
  assertCreatableTeamName,
  cloneConfig,
  cloneConfigMap,
  configsToRecord,
  normalizeConfig,
  normalizeTeamName,
};

/**
 * 历史上内置默认 team 曾把这组示例值写进每个系统 Agent 的 default tier，随租户
 * 初始化持久化后成为指向不存在 provider 的失效引用（无头执行/定时任务直接失败）。
 * 保留常量仅供加载自愈迁移做精确识别（isStockDefaultLlmTierMap），新配置不再写入。
 */
export const defaultLlmTier = {
  provider: "my",
  provider_type: "deepseek",
  model_name: "deepseek-chat",
  temperature: 0.3,
  max_completion_tokens: 4096,
  max_context_tokens: 128000,
  extra_params: {},
};

/** tier map 是否为「原样出厂示例副本」：仅 default 档且每个字段与出厂常量全等。 */
export function isStockDefaultLlmTierMap(llmTiers: unknown): boolean {
  if (!isRecord(llmTiers)) {
    return false;
  }
  const keys = Object.keys(llmTiers);
  if (keys.length !== 1 || keys[0] !== "default") {
    return false;
  }
  const tier = llmTiers.default as unknown;
  if (!isRecord(tier)) {
    return false;
  }
  const expected: Record<string, unknown> = { ...defaultLlmTier };
  const actualKeys = Object.keys(tier);
  const expectedKeys = Object.keys(expected);
  if (actualKeys.length !== expectedKeys.length || !expectedKeys.every((key) => actualKeys.includes(key))) {
    return false;
  }
  return expectedKeys.every((key) => {
    const value = tier[key];
    if (isRecord(expected[key])) {
      return isRecord(value) && Object.keys(value).length === 0;
    }
    return value === expected[key];
  });
}

export function buildCustomAgentConfig(input: CreateAgentRequest): AgentConfig {
  return normalizeConfig({
    agent_name: input.agent_name,
    display_name: input.display_name ?? input.agent_name,
    description: input.description ?? "",
    enabled: true,
    default_entry: input.default_entry ?? false,
    llm_tiers: input.llm ? { default: { ...input.llm } } : null,
    tools: { enabled_tools: [] },
    goals: { enabled: false },
    tasks: { background: false },
    delegation: { enabled_agents: [], parallel_children: false },
    custom_params: input.custom_params ?? {},
  });
}

export function configToAgentInfo(config: AgentConfig): AgentInfo {
  return {
    agent_name: config.agent_name,
    display_name: config.display_name ?? config.agent_name,
    description: config.description ?? null,
    tools: config.tools?.enabled_tools ?? [],
    default_entry: config.default_entry,
    config: {
      enabled: config.enabled,
      llm_tiers: config.llm_tiers ?? null,
      custom_params: config.custom_params,
    },
  };
}

export function normalizeAgentName(agentName: string): string {
  const normalized = agentName.trim();
  if (!normalized) {
    throw new Error("智能体名称不能为空");
  }
  return normalized;
}

export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch === undefined ? base : patch;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    merged[key] = deepMerge(merged[key], value);
  }
  return merged;
}

