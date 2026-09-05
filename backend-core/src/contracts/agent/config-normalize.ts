import type { AgentConfig } from "./agent-config.js";
import { retiredToolNameAliases } from "./tool-name-aliases.js";
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
  "agent",
  "list_child_agents",
]);

export function stripConfigManagedToolNames(enabledTools: readonly string[] | undefined): string[] {
  return (enabledTools ?? []).filter((toolName) => !CONFIG_MANAGED_TOOL_NAMES.has(toolName));
}

/**
 * 退役工具名归一为现名（插件经描述符 retired_names 声明、core 聚合，本层不硬编码
 * 任何插件工具名；core 自有工具的退役名单在上方 CONFIG_MANAGED_TOOL_NAMES）。
 * 保序去重；无别名声明时（注册表为空）原样返回副本。
 */
export function canonicalizeEnabledToolNames(
  enabledTools: readonly string[],
  aliases: Readonly<Record<string, string>> = retiredToolNameAliases(),
): string[] {
  if (!Object.keys(aliases).length) {
    return [...enabledTools];
  }
  const next: string[] = [];
  for (const toolName of enabledTools) {
    const canonical = aliases[toolName] ?? toolName;
    if (!next.includes(canonical)) next.push(canonical);
  }
  return next;
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
      enabled_tools: canonicalizeEnabledToolNames(stripConfigManagedToolNames(tools.enabled_tools)),
    },
    goals: config.goals ?? { enabled: false },
    tasks: config.tasks ?? { background: false },
    delegation: {
      enabled_agents: config.delegation?.enabled_agents ?? [],
      parallel_children: config.delegation?.parallel_children ?? false,
    },
    custom_params: config.custom_params ?? {},
  };
}

/** 新建 Team 的命名 pattern，与 agent-builder 蓝图 IdentifierSchema 一致；存量非规范名仍可读取。 */
export const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

export function normalizeTeamName(teamName: string): string {
  const normalized = teamName.trim();
  if (!normalized) {
    throw new Error("team_name 不能为空");
  }
  return normalized;
}

/** 创建通道的命名校验：直建 HTTP、applyTeamPayload 等都经 createTeam 收口到这里。 */
export function assertCreatableTeamName(teamName: string): string {
  const normalized = normalizeTeamName(teamName);
  if (normalized.length > 64 || !TEAM_NAME_PATTERN.test(normalized)) {
    throw new Error(`team_name '${normalized}' 不合法：须匹配 ${TEAM_NAME_PATTERN.source} 且不超过 64 字符`);
  }
  return normalized;
}
