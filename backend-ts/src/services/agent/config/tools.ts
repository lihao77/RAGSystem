type ToolRiskLevel = "low" | "medium" | "high";

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

export interface AvailableToolInfo {
  name: string;
  description: string;
  category: string;
  runtime_status: "implemented" | "not_migrated";
  implemented: boolean;
  risk_level: ToolRiskLevel;
}

export function listAvailableTools(): AvailableToolInfo[] {
  return allRuntimeTools().filter((tool) => !CONFIG_MANAGED_TOOL_NAMES.has(tool.name));
}

export function stripConfigManagedToolNames(enabledTools: readonly string[] | undefined): string[] {
  return (enabledTools ?? []).filter((toolName) => !CONFIG_MANAGED_TOOL_NAMES.has(toolName));
}

function allRuntimeTools(): AvailableToolInfo[] {
  return [
    implementedTool("read_file", "Read a file from the managed workspace", "filesystem", "low"),
    implementedTool("write_file", "Write a file in the managed workspace", "filesystem", "high"),
    implementedTool("edit_file", "Edit an existing file in the managed workspace", "filesystem", "high"),
    implementedTool("preview_data_structure", "Preview structured data files", "data", "low"),
    implementedTool("glob", "Find files in the managed workspace using glob patterns", "filesystem", "low"),
    implementedTool("grep", "Search text in managed workspace files", "filesystem", "low"),
    implementedTool("web_fetch", "Fetch HTTP/HTTPS content as readable text", "network", "medium"),
    implementedTool("todo_write", "Replace the current session todo list", "task", "low"),
    implementedTool("execute_bash", "Execute a foreground shell command with approval boundaries", "execution", "high"),
    implementedTool("execute_code", "Execute Python code in a restricted sandbox", "execution", "high"),
    implementedTool("task_create", "Create a session-scoped task record", "task", "low"),
    implementedTool("task_get", "Read a session-scoped task record", "task", "low"),
    implementedTool("task_update", "Update a session-scoped task record", "task", "low"),
    implementedTool("task_list", "List session-scoped task records", "task", "low"),
    implementedTool("task_output", "Read a background task status and output", "task", "low"),
    implementedTool("task_stop", "Stop a cancellable background task", "task", "medium"),
    implementedTool("call_agent", "Delegate a subtask to an allowed child Agent", "agent_delegation", "low"),
    implementedTool("list_child_agents", "List child Agent sessions for the current session", "agent_delegation", "low"),
    implementedTool("send_message", "Continue an existing child Agent session", "agent_delegation", "low"),
    implementedTool("search_knowledge_base", "Search enabled Agent knowledge base collections", "knowledge", "low"),
    implementedTool("list_knowledge_collections", "List available knowledge base collections", "knowledge", "low"),
    implementedTool("activate_skill", "Activate a Skill and load its main instructions", "skill", "low"),
    implementedTool("load_skill_resource", "Load a Skill additional resource file", "skill", "low"),
    implementedTool("execute_skill_script", "Execute a Skill utility script", "skill", "medium"),
  ];
}

function implementedTool(
  name: string,
  description: string,
  category: string,
  riskLevel: ToolRiskLevel,
): AvailableToolInfo {
  return {
    name,
    description,
    category,
    runtime_status: "implemented",
    implemented: true,
    risk_level: riskLevel,
  };
}
