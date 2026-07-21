import type { AgentConfig } from "./agent-config.js";
import type { AgentConfigTeam } from "./team-store.js";

/** Tool names owned by runtime/config wiring; strip them from persisted agent tool lists. */
export const CONFIG_MANAGED_TOOL_NAMES = new Set([
  "list_memory_index",
  "read_memory_entry",
  "write_memory",
  "archive_memory",
  "request_user_input",
  "task_create",
  "task_get",
  "task_update",
  "task_list",
  "task_output",
  "task_stop",
  "call_agent",
  "list_child_agents",
  "send_message",
  "search_knowledge_base",
  "list_knowledge_collections",
  "activate_skill",
  "load_skill_resource",
  "execute_skill_script",
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
    skills: config.skills ?? { enabled_skills: [] },
    mcp: config.mcp ?? { enabled_servers: [] },
    memory: config.memory ?? {
      auto_inject: true,
      allowed_scopes: ["team", "session", "user"],
      write_scopes: ["session", "user"],
      archive_scopes: ["session", "user"],
    },
    tasks: config.tasks ?? { workflow: false, background: false },
    delegation: config.delegation ?? { enabled_agents: [] },
    knowledge_base: config.knowledge_base ?? {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
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
