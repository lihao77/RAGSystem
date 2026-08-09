import { CONFIG_MANAGED_TOOL_NAMES } from "../../../contracts/agent/config-normalize.js";
import type { AvailableToolInfo } from "../../../contracts/agent/agent-config.js";

export { CONFIG_MANAGED_TOOL_NAMES, stripConfigManagedToolNames } from "../../../contracts/agent/config-normalize.js";

export type { AvailableToolInfo } from "../../../contracts/agent/agent-config.js";

export function listAvailableTools(): AvailableToolInfo[] {
  return allRuntimeTools().filter((tool) => !CONFIG_MANAGED_TOOL_NAMES.has(tool.name));
}

function allRuntimeTools(): AvailableToolInfo[] {
  return [
    availableTool("goal_create", "Create a durable session Goal with success criteria and stages", "goal", "low"),
    availableTool("goal_get", "Read the current or historical session Goal", "goal", "low"),
    availableTool("goal_update", "Update Goal progress, stages, checkpoint, or lifecycle", "goal", "low"),
    availableTool("goal_list", "List current and historical session Goals", "goal", "low"),
    availableTool("task_output", "Read a background task status and output", "task", "low"),
    availableTool("task_stop", "Stop a cancellable background task", "task", "medium"),
    availableTool("agent", "Create or communicate with an allowed child Agent", "agent_delegation", "low"),
    availableTool("list_child_agents", "List child Agent sessions for the current session", "agent_delegation", "low"),
  ];
}

function availableTool(
  name: string,
  description: string,
  category: string,
  riskLevel: AvailableToolInfo["risk_level"],
): AvailableToolInfo {
  return {
    name,
    description,
    category,
    risk_level: riskLevel,
  };
}
