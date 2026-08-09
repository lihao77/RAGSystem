import { isRecord } from "../../../utils/guards.js";
export { isRecord };
import type { AgentConfig, AgentInfo, CreateAgentRequest } from "../../../contracts/agent/agent-config.js";
import {
  cloneConfig,
  cloneConfigMap,
  configsToRecord,
  normalizeConfig,
  normalizeTeamName,
} from "../../../contracts/agent/config-normalize.js";
import type { AgentConfigTeam } from "../../../contracts/agent/team-store.js";

export type TeamConfigs = AgentConfigTeam;
export {
  cloneConfig,
  cloneConfigMap,
  configsToRecord,
  normalizeConfig,
  normalizeTeamName,
};

export const agentConfigPresets = {
  fast: { temperature: 0.1, max_completion_tokens: 2048 },
  balanced: { temperature: 0.5, max_completion_tokens: 4096 },
  accurate: { temperature: 0.1, max_completion_tokens: 8192 },
  creative: { temperature: 0.9, max_completion_tokens: 4096 },
  cheap: { temperature: 0.5, max_completion_tokens: 2048 },
} as const;

export const defaultLlmTier = {
  provider: "my",
  provider_type: "deepseek",
  model_name: "deepseek-chat",
  temperature: 0.3,
  max_completion_tokens: 4096,
  max_context_tokens: 128000,
  extra_params: {},
};

export function buildDefaultAgentConfigs(): Record<string, AgentConfig> {
  const specialistAgents = ["plan_agent", "explor_agent", "general_agent", "review_agent", "test_agent"];
  return {
    orchestrator_agent: buildSystemAgentConfig({
      agent_name: "orchestrator_agent",
      display_name: "Orchestrator Agent",
      description: "系统默认主编排器，负责理解用户需求、路由任务并整合最终答案。",
      system_prompt: "你是系统默认主编排器，负责优先直接解决问题；必要时再委派给 team 内其他系统 Agent。",
      default_entry: true,
      tools: ["read_file", "write_file", "edit_file", "preview_data_structure", "execute_bash", "execute_code", "glob", "grep", "web_fetch", "todo_write"],
      delegation: specialistAgents,
      goals: { enabled: true },
      tasks: { background: true },
    }),
    plan_agent: buildSystemAgentConfig({
      agent_name: "plan_agent",
      display_name: "Plan Agent",
      description: "系统默认规划 Agent，负责方案设计、任务拆解和实现路径规划。",
      system_prompt: "你负责阅读上下文后给出精炼、可执行的实现计划，明确改动点、验证路径和边界。",
      delegation: ["explor_agent", "general_agent"],
    }),
    explor_agent: buildSystemAgentConfig({
      agent_name: "explor_agent",
      display_name: "Explore Agent",
      description: "系统默认探索 Agent，负责搜索代码库、定位实现与归纳上下文。",
      system_prompt: "你负责快速探索仓库，定位相关文件、现有实现和可复用模式。",
      tools: ["read_file", "preview_data_structure", "glob", "grep"],
    }),
    general_agent: buildSystemAgentConfig({
      agent_name: "general_agent",
      display_name: "General Agent",
      description: "系统默认通用执行 Agent，负责处理中等复杂度的综合实现与代码修改。",
      system_prompt: "你负责承接通用实现任务，优先复用现有代码模式，直接产出完成所需的最少改动。",
      tools: ["read_file", "write_file", "edit_file", "preview_data_structure", "execute_bash", "execute_code", "glob", "grep", "web_fetch", "todo_write"],
      delegation: ["explor_agent"],
    }),
    review_agent: buildSystemAgentConfig({
      agent_name: "review_agent",
      display_name: "Review Agent",
      description: "系统默认评审 Agent，负责检查改动质量、复用性和潜在问题。",
      system_prompt: "你负责审查当前改动，聚焦正确性、复用性、一致性和不必要复杂度。",
      tools: ["read_file", "preview_data_structure", "execute_bash", "glob", "grep"],
    }),
    test_agent: buildSystemAgentConfig({
      agent_name: "test_agent",
      display_name: "Test Agent",
      description: "系统默认测试 Agent，负责运行验证命令并定位失败原因。",
      system_prompt: "你负责运行测试、构建和验证命令，准确报告失败点并归纳最直接的修复线索。",
      tools: ["read_file", "preview_data_structure", "execute_bash", "glob", "grep"],
    }),
  };
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

function buildSystemAgentConfig(input: {
  agent_name: string;
  display_name: string;
  description: string;
  system_prompt: string;
  default_entry?: boolean;
  tools?: string[];
  delegation?: string[];
  goals?: { enabled?: boolean };
  tasks?: { background?: boolean };
}): AgentConfig {
  return normalizeConfig({
    agent_name: input.agent_name,
    display_name: input.display_name,
    description: input.description,
    enabled: true,
    default_entry: input.default_entry ?? false,
    llm_tiers: { default: { ...defaultLlmTier } },
    tools: { enabled_tools: input.tools ?? ["read_file", "preview_data_structure"] },
    goals: { enabled: false, ...(input.goals ?? {}) },
    tasks: { background: false, ...(input.tasks ?? {}) },
    delegation: { enabled_agents: input.delegation ?? [], parallel_children: false },
    custom_params: {
      type: "orchestrator",
      behavior: {
        system_prompt: input.system_prompt,
        compression_trigger_ratio: 0.85,
        summarize_max_tokens: 300,
        preserve_recent_turns: 3,
      },
    },
  });
}
