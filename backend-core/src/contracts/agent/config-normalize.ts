import type { AgentConfig } from "./agent-config.js";
import type { AgentConfigTeam } from "./team-store.js";

/** Tool names owned by runtime/config wiring; strip them from persisted agent tool lists. */
export const CONFIG_MANAGED_TOOL_NAMES = new Set([
  "request_user_input",
  "goal_create",
  "goal_get",
  "goal_update",
  "goal_list",
  // Retired workflow tool names are still stripped from older development configs.
  "task_create",
  "task_get",
  "task_update",
  "task_list",
  "task_output",
  "task_stop",
  "call_agent",
  "list_child_agents",
  "send_message",
]);

export function stripConfigManagedToolNames(enabledTools: readonly string[] | undefined): string[] {
  return (enabledTools ?? []).filter((toolName) => !CONFIG_MANAGED_TOOL_NAMES.has(toolName));
}

export function cloneConfig(config: AgentConfig): AgentConfig {
  return structuredClone(config) as AgentConfig;
}

export function configsToRecord(configs: AgentConfigTeam): Record<string, AgentConfig> {
  return Object.fromEntries(Array.from(configs.entries()).map(([name, config]) => [name, cloneConfig(config)]));
}

export function cloneConfigMap(configs: AgentConfigTeam): AgentConfigTeam {
  return new Map(Array.from(configs.entries()).map(([name, config]) => [name, cloneConfig(config)]));
}

/** Fill defaults and strip runtime-managed tool names from a persisted agent config. */
export function normalizeConfig(config: AgentConfig): AgentConfig {
  const tools = config.tools ?? { enabled_tools: [] };
  return {
    ...config,
    display_name: config.display_name ?? null,
    description: config.description ?? null,
    enabled: config.enabled ?? true,
    default_entry: config.default_entry ?? false,
    llm_tiers: config.llm_tiers ?? null,
    tools: {
      ...tools,
      enabled_tools: stripConfigManagedToolNames(tools.enabled_tools),
    },
    mcp: config.mcp ?? { enabled_servers: [] },
    goals: config.goals ?? { enabled: false },
    tasks: config.tasks ?? { background: false },
    delegation: config.delegation ?? { enabled_agents: [] },
    custom_params: config.custom_params ?? {},
  };
}

export function normalizeTeamName(teamName: string): string {
  const normalized = teamName.trim();
  if (!normalized) {
    throw new Error("team_name 不能为空");
  }
  return normalized;
}
