import type { RuntimeToolDefinition } from "../runtime-tool-types.js";

export const READ_ONLY_MEMORY_TOOL_NAMES = ["list_memory_index", "read_memory_entry"] as const;
export type ReadOnlyMemoryToolName = (typeof READ_ONLY_MEMORY_TOOL_NAMES)[number];

export const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";
export const READ_FILE_TOOL_NAME = "read_file";
export const WRITE_FILE_TOOL_NAME = "write_file";
export const EDIT_FILE_TOOL_NAME = "edit_file";
export const PREVIEW_DATA_STRUCTURE_TOOL_NAME = "preview_data_structure";
export const EXECUTE_BASH_TOOL_NAME = "execute_bash";
export const EXECUTE_CODE_TOOL_NAME = "execute_code";
export const GLOB_TOOL_NAME = "glob";
export const GREP_TOOL_NAME = "grep";
export const WEB_FETCH_TOOL_NAME = "web_fetch";
export const TODO_WRITE_TOOL_NAME = "todo_write";
export const CALL_AGENT_TOOL_NAME = "call_agent";
export const LIST_CHILD_AGENTS_TOOL_NAME = "list_child_agents";
export const SEND_MESSAGE_TOOL_NAME = "send_message";
export const TASK_CREATE_TOOL_NAME = "task_create";
export const TASK_GET_TOOL_NAME = "task_get";
export const TASK_UPDATE_TOOL_NAME = "task_update";
export const TASK_LIST_TOOL_NAME = "task_list";
export const TASK_OUTPUT_TOOL_NAME = "task_output";
export const TASK_STOP_TOOL_NAME = "task_stop";
export const WRITE_MEMORY_TOOL_NAME = "write_memory";
export const ARCHIVE_MEMORY_TOOL_NAME = "archive_memory";
export const SEARCH_KNOWLEDGE_BASE_TOOL_NAME = "search_knowledge_base";
export const LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME = "list_knowledge_collections";
export const ACTIVATE_SKILL_TOOL_NAME = "activate_skill";
export const LOAD_SKILL_RESOURCE_TOOL_NAME = "load_skill_resource";
export const EXECUTE_SKILL_SCRIPT_TOOL_NAME = "execute_skill_script";
export const GET_SKILL_INFO_TOOL_NAME = "get_skill_info";

export const REQUEST_USER_INPUT_TOOL: RuntimeToolDefinition = {
  name: REQUEST_USER_INPUT_TOOL_NAME,
  source: "runtime_builtin",
  category: "interaction",
  riskLevel: "low",
  approvalExempt: true,
  description:
    "Ask the user for missing information that is required to continue. Use only when the answer cannot be inferred or obtained with available tools.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["prompt"],
    properties: {
      prompt: {
        type: "string",
        description: "Question shown to the user. Be specific about the missing information.",
      },
      input_type: {
        type: "string",
        enum: ["text", "select"],
        description: "Use text for free-form input, select when options are provided.",
      },
      options: {
        type: "array",
        items: { type: "string" },
        description: "Options for select input_type.",
      },
    },
  },
};

export const DOCUMENT_TOOLS: RuntimeToolDefinition[] = [
  {
    name: READ_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "low",
    description:
      "Read a managed workspace/session file by line range. Defaults to line 1 and at most 2000 lines. Use offset/limit for large files.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: {
        file_path: {
          type: "string",
          description: "File path. Relative paths resolve against the current workspace first, then session managed directories.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
        offset: {
          type: "integer",
          minimum: 1,
          description: "1-based starting line number. Defaults to 1.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 10000,
          description: "Maximum lines to read. Defaults to 2000.",
        },
      },
    },
  },
  {
    name: WRITE_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "high",
    description:
      "Write text or JSON content to a managed workspace/session file. If file_path is omitted, the runtime allocates a managed output path.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["content"],
      properties: {
        content: {
          description: "Content to write. Strings are written as text; objects are serialized when mode=json.",
        },
        file_path: {
          type: "string",
          description: "Optional file path. Relative paths resolve to managed workspace/session roots.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        mode: {
          type: "string",
          enum: ["text", "json"],
          description: "Write mode. Defaults to text.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
      },
    },
  },
  {
    name: EDIT_FILE_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "high",
    description:
      "Edit a managed file by exact string replacement. old_string must match uniquely unless replace_all=true.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path", "old_string", "new_string"],
      properties: {
        file_path: {
          type: "string",
          description: "File path to edit. Relative paths resolve to managed workspace/session roots.",
        },
        old_string: {
          type: "string",
          description: "Exact text to replace. Must include whitespace/newlines exactly.",
        },
        new_string: {
          type: "string",
          description: "Replacement text. Empty string deletes old_string.",
        },
        replace_all: {
          type: "boolean",
          description: "Replace all matches instead of requiring a unique match.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
      },
    },
  },
  {
    name: PREVIEW_DATA_STRUCTURE_TOOL_NAME,
    source: "document",
    category: "data",
    riskLevel: "low",
    description:
      "Preview the data structure of a managed JSON, YAML, CSV, TSV, or text file without returning the full file content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["file_path"],
      properties: {
        file_path: {
          type: "string",
          description: "File path to preview. Relative paths resolve against managed workspace/session roots.",
        },
        file_path_space: {
          type: "string",
          enum: ["workspace", "transient", "exports"],
          description: "Optional managed path space for relative file_path.",
        },
        encoding: {
          type: "string",
          description: "Text encoding. Defaults to utf-8.",
        },
        max_preview_rows: {
          type: "integer",
          minimum: 1,
          description: "Maximum sampled table rows, text lines, or array items. Defaults to 5.",
        },
        max_depth: {
          type: "integer",
          minimum: 1,
          description: "Maximum nested structure depth for JSON/YAML. Defaults to 3.",
        },
        max_fields: {
          type: "integer",
          minimum: 1,
          description: "Maximum object fields or table columns to summarize. Defaults to 20.",
        },
      },
    },
  },
];

export const EXECUTE_BASH_TOOL: RuntimeToolDefinition = {
  name: EXECUTE_BASH_TOOL_NAME,
  source: "execution",
  category: "execution",
  riskLevel: "high",
  description:
    "Execute a shell command in a managed workspace directory. Read-only commands run directly; write, unknown, network, destructive, and interpreter commands may require approval.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["command"],
    properties: {
      command: {
        type: "string",
        description: "Shell command to execute. Command substitution, hidden newlines, dangerous env overrides, and write redirection are blocked.",
      },
      working_dir: {
        type: "string",
        description: "Optional working directory. Relative paths resolve against the selected managed space, defaulting to workspace.",
      },
      working_dir_space: {
        type: "string",
        enum: ["workspace", "transient", "exports"],
        description: "Managed directory space for working_dir.",
      },
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 600,
        description: "Timeout in seconds. Defaults to 120 and is capped at 600.",
      },
      run_in_background: {
        type: "boolean",
        description: "Run the command in the background and immediately return a background_task_id.",
      },
      description: {
        type: "string",
        description: "Short purpose shown in approval prompts and execution logs.",
      },
    },
  },
};

export const EXECUTE_CODE_TOOL: RuntimeToolDefinition = {
  name: EXECUTE_CODE_TOOL_NAME,
  source: "execution",
  category: "execution",
  riskLevel: "high",
  description:
    "Execute Python code in a restricted sandbox for data processing and limited tool orchestration. Set result as the final output.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["code"],
    properties: {
      code: {
        type: "string",
        description: "Python code. Must assign the final output to the result variable.",
      },
      description: {
        type: "string",
        description: "Short purpose of the code execution.",
      },
      timeout: {
        type: "integer",
        minimum: 1,
        maximum: 300,
        description: "Timeout in seconds. Defaults to 60 and is capped at 300.",
      },
    },
  },
};

export const LOCAL_SEARCH_TOOLS: RuntimeToolDefinition[] = [
  {
    name: GLOB_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "low",
    description: "Find files in the managed workspace using glob patterns such as **/*.ts.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description: "Glob pattern relative to the search root.",
        },
        path: {
          type: "string",
          description: "Optional directory relative to the managed workspace.",
        },
        recursive: {
          type: "boolean",
          description: "Whether to recurse into subdirectories. Defaults to true when pattern contains **.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "Maximum number of paths to return. Defaults to 200.",
        },
      },
    },
  },
  {
    name: GREP_TOOL_NAME,
    source: "document",
    category: "filesystem",
    riskLevel: "low",
    description: "Search text in managed workspace files and return matching lines.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["pattern"],
      properties: {
        pattern: {
          type: "string",
          description: "Literal text pattern to search for.",
        },
        path: {
          type: "string",
          description: "Optional directory relative to the managed workspace.",
        },
        glob: {
          type: "string",
          description: "Optional glob filter, for example **/*.ts.",
        },
        case_sensitive: {
          type: "boolean",
          description: "Whether matching is case-sensitive. Defaults to false.",
        },
        max_results: {
          type: "integer",
          minimum: 1,
          maximum: 5000,
          description: "Maximum matches to return. Defaults to 200.",
        },
        context_lines: {
          type: "integer",
          minimum: 0,
          maximum: 20,
          description: "Number of surrounding lines to include. Defaults to 0.",
        },
      },
    },
  },
  {
    name: WEB_FETCH_TOOL_NAME,
    source: "runtime_builtin",
    category: "network",
    riskLevel: "medium",
    description: "Fetch an HTTP or HTTPS URL and return readable text content.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["url"],
      properties: {
        url: {
          type: "string",
          description: "HTTP or HTTPS URL to fetch.",
        },
        timeout_ms: {
          type: "integer",
          minimum: 1000,
          maximum: 60000,
          description: "Request timeout in milliseconds. Defaults to 15000.",
        },
        max_chars: {
          type: "integer",
          minimum: 1000,
          maximum: 200000,
          description: "Maximum returned characters. Defaults to 20000.",
        },
      },
    },
  },
  {
    name: TODO_WRITE_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    description: "Replace the current session todo list with pending, in_progress, or completed items.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["todos"],
      properties: {
        todos: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["content", "status"],
            properties: {
              content: { type: "string" },
              status: { type: "string", enum: ["pending", "in_progress", "completed"] },
              active_form: { type: "string" },
            },
          },
        },
      },
    },
  },
];

export const KNOWLEDGE_TOOLS: RuntimeToolDefinition[] = [
  {
    name: SEARCH_KNOWLEDGE_BASE_TOOL_NAME,
    source: "knowledge",
    category: "knowledge",
    riskLevel: "low",
    description:
      "Search the enabled Agent knowledge base for document chunks relevant to a query. Uses Agent knowledge_base defaults when optional fields are omitted.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["query"],
      properties: {
        query: {
          type: "string",
          description: "Search query text.",
        },
        collection: {
          type: "string",
          description: "Knowledge collection name. Defaults to the Agent knowledge_base default_collection.",
        },
        top_k: {
          type: "integer",
          minimum: 1,
          description: "Maximum result count. Defaults to the Agent knowledge_base default_top_k.",
        },
        search_mode: {
          type: "string",
          enum: ["vector", "hybrid"],
          description: "Search mode. Defaults to the Agent knowledge_base default_search_mode.",
        },
        rerank: {
          type: "boolean",
          description: "Whether to rerank hybrid results. Defaults to the Agent knowledge_base default_rerank.",
        },
        filters: {
          type: "object",
          description: "Optional metadata filters reserved for vector-store compatible callers.",
        },
      },
    },
  },
  {
    name: LIST_KNOWLEDGE_COLLECTIONS_TOOL_NAME,
    source: "knowledge",
    category: "knowledge",
    riskLevel: "low",
    description: "List available knowledge base collections and their document/chunk counts.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

export const SKILL_TOOLS: RuntimeToolDefinition[] = [
  {
    name: ACTIVATE_SKILL_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    description: "Activate a Skill and return its SKILL.md main instructions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: LOAD_SKILL_RESOURCE_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    description: "Load an additional resource file from an activated Skill.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name", "resource_file"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        resource_file: { type: "string", description: "Relative resource file name." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: EXECUTE_SKILL_SCRIPT_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "medium",
    description: "Execute a Skill utility script with string arguments.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name", "script_name"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        script_name: { type: "string", description: "Script file name under the Skill scripts directory." },
        arguments: { type: "array", items: { type: "string" }, description: "Command line arguments." },
        run_in_background: { type: "boolean", description: "Reserved for background execution." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
  {
    name: GET_SKILL_INFO_TOOL_NAME,
    source: "runtime_builtin",
    category: "skill",
    riskLevel: "low",
    description: "Get lightweight Skill metadata without loading full instructions.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["skill_name"],
      properties: {
        skill_name: { type: "string", description: "Skill name." },
        workspace_root: { type: "string", description: "Optional workspace root for workspace Skills." },
      },
    },
  },
];

export const READ_ONLY_MEMORY_TOOLS: RuntimeToolDefinition[] = [
  {
    name: "list_memory_index",
    source: "memory",
    category: "memory",
    riskLevel: "low",
    description: "List the MEMORY.md index for an allowed memory scope before selecting an entry file to read.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scope"],
      properties: {
        scope: {
          type: "string",
          enum: ["team", "session", "agent", "workspace"],
          description: "Memory scope to inspect.",
        },
        session_id: {
          type: "string",
          description: "Optional session id. Omit it when the current session context should be used.",
        },
        agent_name: {
          type: "string",
          description: "Optional agent name for agent-scoped memory.",
        },
        workspace_key: {
          type: "string",
          description: "Optional normalized workspace memory key.",
        },
        team_name: {
          type: "string",
          description: "Optional team name for team-scoped or agent-scoped memory.",
        },
        workspace_root: {
          type: "string",
          description: "Optional workspace root path used to derive workspace memory.",
        },
      },
    },
  },
  {
    name: "read_memory_entry",
    source: "memory",
    category: "memory",
    riskLevel: "low",
    description: "Read one memory entry file from an allowed memory scope after checking the index.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["scope", "file_name"],
      properties: {
        scope: {
          type: "string",
          enum: ["team", "session", "agent", "workspace"],
          description: "Memory scope containing the entry file.",
        },
        file_name: {
          type: "string",
          description: "Memory entry file name from the index, for example fact_alpha.md.",
        },
        session_id: {
          type: "string",
          description: "Optional session id. Omit it when the current session context should be used.",
        },
        agent_name: {
          type: "string",
          description: "Optional agent name for agent-scoped memory.",
        },
        workspace_key: {
          type: "string",
          description: "Optional normalized workspace memory key.",
        },
        team_name: {
          type: "string",
          description: "Optional team name for team-scoped or agent-scoped memory.",
        },
        workspace_root: {
          type: "string",
          description: "Optional workspace root path used to derive workspace memory.",
        },
      },
    },
  },
];

export const WRITE_MEMORY_TOOL: RuntimeToolDefinition = {
  name: WRITE_MEMORY_TOOL_NAME,
  source: "memory",
  category: "memory",
  riskLevel: "low",
  description: "Create or update one memory entry in an allowed writable scope and rebuild that scope's MEMORY.md index.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "name", "description", "memory_type", "content"],
    properties: {
      scope: {
        type: "string",
        enum: ["team", "session", "agent", "workspace"],
        description: "Memory scope to write.",
      },
      name: {
        type: "string",
        description: "Memory name.",
      },
      description: {
        type: "string",
        description: "Short memory summary used in MEMORY.md.",
      },
      memory_type: {
        type: "string",
        enum: ["preference", "constraint", "goal", "fact", "profile"],
        description: "Memory type.",
      },
      content: {
        type: "string",
        description: "Memory body.",
      },
      why: {
        type: "string",
        description: "Optional Why section.",
      },
      how_to_apply: {
        type: "string",
        description: "Optional How to apply section.",
      },
      source_run_id: {
        type: "string",
        description: "Optional source run id.",
      },
      source_message_id: {
        type: "string",
        description: "Optional source message id.",
      },
      session_id: {
        type: "string",
        description: "Optional session id. Omit it when the current session context should be used.",
      },
      agent_name: {
        type: "string",
        description: "Optional agent name for agent-scoped memory.",
      },
      workspace_key: {
        type: "string",
        description: "Optional normalized workspace memory key.",
      },
      team_name: {
        type: "string",
        description: "Optional team name for team-scoped or agent-scoped memory.",
      },
      workspace_root: {
        type: "string",
        description: "Optional workspace root path used to derive workspace memory.",
      },
    },
  },
};

export const ARCHIVE_MEMORY_TOOL: RuntimeToolDefinition = {
  name: ARCHIVE_MEMORY_TOOL_NAME,
  source: "memory",
  category: "memory",
  riskLevel: "low",
  description: "Archive one memory entry in an allowed archive scope and rebuild that scope's MEMORY.md index.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["scope", "file_name"],
    properties: {
      scope: {
        type: "string",
        enum: ["team", "session", "agent", "workspace"],
        description: "Memory scope containing the entry file.",
      },
      file_name: {
        type: "string",
        description: "Memory entry file name to archive.",
      },
      session_id: {
        type: "string",
        description: "Optional session id. Omit it when the current session context should be used.",
      },
      agent_name: {
        type: "string",
        description: "Optional agent name for agent-scoped memory.",
      },
      workspace_key: {
        type: "string",
        description: "Optional normalized workspace memory key.",
      },
      team_name: {
        type: "string",
        description: "Optional team name for team-scoped or agent-scoped memory.",
      },
      workspace_root: {
        type: "string",
        description: "Optional workspace root path used to derive workspace memory.",
      },
    },
  },
};

export const TASK_WORKFLOW_TOOLS: RuntimeToolDefinition[] = [
  {
    name: TASK_CREATE_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    description: "Create a session-scoped task record for multi-step work tracking.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["subject", "description"],
      properties: {
        subject: { type: "string", description: "Short task title." },
        description: { type: "string", description: "Detailed task description and acceptance criteria." },
        active_form: { type: "string", description: "Display text while the task is in progress." },
        metadata: { type: "object", description: "Optional metadata." },
      },
    },
  },
  {
    name: TASK_GET_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    description: "Read a session-scoped task by id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: { type: "string", description: "Task id returned by task_create." },
      },
    },
  },
  {
    name: TASK_UPDATE_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    description: "Update task fields, status, dependency links, or metadata.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["task_id"],
      properties: {
        task_id: { type: "string" },
        subject: { type: "string" },
        description: { type: "string" },
        active_form: { type: "string" },
        owner: { type: "string" },
        status: { type: "string", enum: ["pending", "in_progress", "completed", "deleted"] },
        add_blocks: { type: "array", items: { type: "string" } },
        add_blocked_by: { type: "array", items: { type: "string" } },
        metadata: { type: "object" },
      },
    },
  },
  {
    name: TASK_LIST_TOOL_NAME,
    source: "runtime_builtin",
    category: "task",
    riskLevel: "low",
    description: "List session-scoped task summaries.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  },
];

export const TASK_OUTPUT_TOOL: RuntimeToolDefinition = {
  name: TASK_OUTPUT_TOOL_NAME,
  source: "runtime_builtin",
  category: "task",
  riskLevel: "low",
  description: "Read a background task status and output, optionally requesting an explicit wait.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task_id"],
    properties: {
      task_id: { type: "string", description: "Background task id." },
      block: { type: "boolean", description: "Whether to request waiting for completion." },
      timeout: { type: "integer", minimum: 0, maximum: 600000, description: "Wait timeout in milliseconds." },
      max_chars: { type: "integer", minimum: 200, description: "Maximum output characters to read." },
    },
  },
};

export const TASK_STOP_TOOL: RuntimeToolDefinition = {
  name: TASK_STOP_TOOL_NAME,
  source: "runtime_builtin",
  category: "task",
  riskLevel: "medium",
  description: "Stop a cancellable background task.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["task_id"],
    properties: {
      task_id: { type: "string", description: "Background task id." },
    },
  },
};

export const AGENT_DELEGATION_TOOLS: RuntimeToolDefinition[] = [
  {
    name: CALL_AGENT_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    description:
      "Delegate a self-contained subtask to one allowed child Agent. agent_name must come from the current Agent delegation allowlist.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["agent_name", "task"],
      properties: {
        agent_name: {
          type: "string",
          description: "Target child Agent name from the current delegation allowlist.",
        },
        task: {
          type: "string",
          description: "Complete task description with all context the child Agent needs.",
        },
        context_hint: {
          type: "string",
          description: "Optional extra constraints, output format, or background.",
        },
      },
    },
  },
  {
    name: LIST_CHILD_AGENTS_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    description: "List existing child Agent sessions in the current session so a prior child_agent_id can be reused.",
    parameters: {
      type: "object",
      additionalProperties: false,
      properties: {
        agent_name: {
          type: "string",
          description: "Optional Agent name filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Maximum number of child Agents to return. Defaults to 20.",
        },
      },
    },
  },
  {
    name: SEND_MESSAGE_TOOL_NAME,
    source: "agent_tool",
    category: "agent_delegation",
    riskLevel: "low",
    description: "Send a follow-up message to an existing child Agent session by child_agent_id.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["child_agent_id", "message"],
      properties: {
        child_agent_id: {
          type: "string",
          description: "Child Agent id returned by call_agent or list_child_agents.",
        },
        message: {
          type: "string",
          description: "Follow-up task or correction for the existing child Agent.",
        },
      },
    },
  },
];
