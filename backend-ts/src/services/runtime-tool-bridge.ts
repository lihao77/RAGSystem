import type { AgentConfig } from "../contracts/agent-config.js";
import {
  type ToolExecutionResult,
  type MemoryToolService,
} from "./memory-tool-service.js";
import type { LocalDocumentToolService } from "./local-document-tool-service.js";
import type { AgentDelegationService } from "./agent-delegation-service.js";
import type { TaskToolService } from "./task-tool-service.js";
import type {
  BashExecutionInput,
  BashExecutionPlan,
  LocalBashToolService,
} from "./local-bash-tool-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolExecutor,
  RuntimeToolWaitRequest,
  RuntimeToolWaitResult,
} from "./runtime-tool-types.js";
import type { PendingInteractionService } from "./pending-interaction-service.js";
import type {
  PermissionPolicyService,
  RuntimeToolApprovalDecision,
} from "./permission-policy-service.js";

const READ_ONLY_MEMORY_TOOL_NAMES = ["list_memory_index", "read_memory_entry"] as const;
type ReadOnlyMemoryToolName = (typeof READ_ONLY_MEMORY_TOOL_NAMES)[number];

const REQUEST_USER_INPUT_TOOL_NAME = "request_user_input";
const READ_FILE_TOOL_NAME = "read_file";
const WRITE_FILE_TOOL_NAME = "write_file";
const EDIT_FILE_TOOL_NAME = "edit_file";
const PREVIEW_DATA_STRUCTURE_TOOL_NAME = "preview_data_structure";
const EXECUTE_BASH_TOOL_NAME = "execute_bash";
const CALL_AGENT_TOOL_NAME = "call_agent";
const LIST_CHILD_AGENTS_TOOL_NAME = "list_child_agents";
const SEND_MESSAGE_TOOL_NAME = "send_message";
const TASK_CREATE_TOOL_NAME = "task_create";
const TASK_GET_TOOL_NAME = "task_get";
const TASK_UPDATE_TOOL_NAME = "task_update";
const TASK_LIST_TOOL_NAME = "task_list";
const TASK_OUTPUT_TOOL_NAME = "task_output";
const TASK_STOP_TOOL_NAME = "task_stop";
const WRITE_MEMORY_TOOL_NAME = "write_memory";
const ARCHIVE_MEMORY_TOOL_NAME = "archive_memory";

const REQUEST_USER_INPUT_TOOL: RuntimeToolDefinition = {
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

const DOCUMENT_TOOLS: RuntimeToolDefinition[] = [
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

const EXECUTE_BASH_TOOL: RuntimeToolDefinition = {
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

const READ_ONLY_MEMORY_TOOLS: RuntimeToolDefinition[] = [
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

const WRITE_MEMORY_TOOL: RuntimeToolDefinition = {
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

const ARCHIVE_MEMORY_TOOL: RuntimeToolDefinition = {
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

const TASK_WORKFLOW_TOOLS: RuntimeToolDefinition[] = [
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

const TASK_OUTPUT_TOOL: RuntimeToolDefinition = {
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

const TASK_STOP_TOOL: RuntimeToolDefinition = {
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

const AGENT_DELEGATION_TOOLS: RuntimeToolDefinition[] = [
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

export class RuntimeToolBridge implements RuntimeToolExecutor {
  private agentDelegation: AgentDelegationService | null = null;

  constructor(
    private readonly memoryTools: MemoryToolService,
    private readonly pendingInteractions: PendingInteractionService | null = null,
    private readonly permissionPolicy: PermissionPolicyService | null = null,
    private readonly documentTools: LocalDocumentToolService | null = null,
    private readonly bashTools: LocalBashToolService | null = null,
    private readonly taskTools: TaskToolService | null = null,
  ) {}

  setAgentDelegation(agentDelegation: AgentDelegationService | null): void {
    this.agentDelegation = agentDelegation;
  }

  listVisibleTools(agent: AgentConfig | null): RuntimeToolDefinition[] {
    const tools: RuntimeToolDefinition[] = [];
    const enabledTools = new Set(agent?.tools.enabled_tools ?? []);
    if (this.pendingInteractions) {
      tools.push({ ...REQUEST_USER_INPUT_TOOL });
    }
    if (this.documentTools) {
      for (const tool of DOCUMENT_TOOLS) {
        if (enabledTools.has(tool.name)) {
          tools.push({ ...tool });
        }
      }
    }
    if (this.bashTools && enabledTools.has(EXECUTE_BASH_TOOL_NAME)) {
      tools.push({ ...EXECUTE_BASH_TOOL });
    }
    if (this.taskTools) {
      if (agent?.tasks?.workflow) {
        tools.push(...TASK_WORKFLOW_TOOLS.map((tool) => ({ ...tool })));
      }
      if (enabledTools.has(TASK_OUTPUT_TOOL_NAME)) {
        tools.push({ ...TASK_OUTPUT_TOOL });
      }
      if (agent?.tasks?.background) {
        tools.push({ ...TASK_STOP_TOOL });
      }
    }
    const memoryConfig = agent?.memory;
    if (memoryConfig?.allowed_scopes?.length) {
      tools.push(...READ_ONLY_MEMORY_TOOLS.map((tool) => ({ ...tool })));
    }
    if (memoryConfig?.write_scopes?.length) {
      tools.push({ ...WRITE_MEMORY_TOOL });
    }
    if (memoryConfig?.archive_scopes?.length) {
      tools.push({ ...ARCHIVE_MEMORY_TOOL });
    }
    if (this.agentDelegation && agent?.delegation.enabled_agents?.length) {
      tools.push(...AGENT_DELEGATION_TOOLS.map((tool) => ({ ...tool })));
    }
    return tools;
  }

  listVisibleToolNames(agent: AgentConfig | null): string[] {
    return this.listVisibleTools(agent).map((tool) => tool.name);
  }

  canExecuteTool(toolName: string, agent: AgentConfig | null): boolean {
    return this.listVisibleToolNames(agent).includes(toolName);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult> {
    const executionContext = buildToolCallContext(call, context);
    const toolName = call.toolName.trim();
    const tool = this.getVisibleTool(toolName, executionContext.agent);
    if (!tool) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }

    if (toolName === EXECUTE_BASH_TOOL_NAME && this.bashTools) {
      return this.executeBashTool(call, executionContext);
    }

    const approvalDecision = this.permissionPolicy?.evaluateToolApproval({
      toolName,
      riskLevel: tool.riskLevel,
      description: tool.description,
      arguments: call.arguments ?? {},
      sessionId: executionContext.sessionId,
      approvalExempt: tool.approvalExempt,
    });
    if (approvalDecision?.action === "ask") {
      return this.executeToolAfterApproval(call, executionContext, approvalDecision);
    }

    return this.executeAllowedTool(toolName, call, executionContext);
  }

  waitForToolResult(
    request: RuntimeToolWaitRequest,
    context: RuntimeToolExecutionContext,
  ): RuntimeToolWaitResult | Promise<RuntimeToolWaitResult> {
    if (!this.taskTools) {
      return {
        success: false,
        timeout: false,
        payloads: [
          {
            task_id: request.backgroundTaskId,
            background_task_id: request.backgroundTaskId,
            status: "missing",
            success: false,
            summary: `后台任务 ${request.backgroundTaskId} 不存在`,
          },
        ],
      };
    }
    return this.taskTools.waitForBackgroundTask({
      taskId: request.backgroundTaskId,
      timeoutMs: request.timeoutMs,
      signal: context.signal,
    });
  }

  private getVisibleTool(toolName: string, agent: AgentConfig | null): RuntimeToolDefinition | null {
    return this.listVisibleTools(agent).find((tool) => tool.name === toolName) ?? null;
  }

  private executeAllowedTool(
    toolName: string,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
  ): ToolExecutionResult | Promise<ToolExecutionResult> {
    if (toolName === REQUEST_USER_INPUT_TOOL_NAME) {
      return this.requestUserInput(call, context);
    }
    if (toolName === READ_FILE_TOOL_NAME && this.documentTools) {
      return this.documentTools.readFile(readFileArguments(call.arguments), context);
    }
    if (toolName === WRITE_FILE_TOOL_NAME && this.documentTools) {
      return this.documentTools.writeFile(writeFileArguments(call.arguments), context);
    }
    if (toolName === EDIT_FILE_TOOL_NAME && this.documentTools) {
      return this.documentTools.editFile(editFileArguments(call.arguments), context);
    }
    if (toolName === PREVIEW_DATA_STRUCTURE_TOOL_NAME && this.documentTools) {
      return this.documentTools.previewDataStructure(previewDataStructureArguments(call.arguments), context);
    }
    if (toolName === TASK_CREATE_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskCreate(readTaskCreateArguments(call.arguments), context);
    }
    if (toolName === TASK_GET_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskGet(readTaskGetArguments(call.arguments), context);
    }
    if (toolName === TASK_UPDATE_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskUpdate(readTaskUpdateArguments(call.arguments), context);
    }
    if (toolName === TASK_LIST_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskList(context);
    }
    if (toolName === TASK_OUTPUT_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskOutput(readTaskOutputArguments(call.arguments));
    }
    if (toolName === TASK_STOP_TOOL_NAME && this.taskTools) {
      return this.taskTools.taskStop(readTaskStopArguments(call.arguments));
    }
    if (toolName === "list_memory_index") {
      return this.memoryTools.listMemoryIndex(readListMemoryIndexArguments(call.arguments), context);
    }
    if (toolName === "read_memory_entry") {
      return this.memoryTools.readMemoryEntry(readMemoryEntryArguments(call.arguments), context);
    }
    if (toolName === WRITE_MEMORY_TOOL_NAME) {
      return this.memoryTools.writeMemory(readWriteMemoryArguments(call.arguments), context);
    }
    if (toolName === ARCHIVE_MEMORY_TOOL_NAME) {
      return this.memoryTools.archiveMemory(readArchiveMemoryArguments(call.arguments), context);
    }
    if (toolName === CALL_AGENT_TOOL_NAME && this.agentDelegation) {
      return this.agentDelegation.callAgent(readCallAgentArguments(call.arguments, context.toolCallId ?? call.callId), context);
    }
    if (toolName === LIST_CHILD_AGENTS_TOOL_NAME && this.agentDelegation) {
      return this.agentDelegation.listChildAgents(readListChildAgentsArguments(call.arguments), context);
    }
    if (toolName === SEND_MESSAGE_TOOL_NAME && this.agentDelegation) {
      return this.agentDelegation.sendMessage(readSendMessageArguments(call.arguments, context.toolCallId ?? call.callId), context);
    }
    return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName);
  }

  private async executeBashTool(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!this.bashTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_BASH_TOOL_NAME}`, EXECUTE_BASH_TOOL_NAME);
    }
    const prepared = this.bashTools.prepareExecution(readBashArguments(call.arguments), context);
    if (!prepared.ok) {
      return prepared.result;
    }

    const plan = prepared.plan;
    const approvalDecision = this.permissionPolicy?.evaluateToolApproval({
      toolName: EXECUTE_BASH_TOOL_NAME,
      riskLevel: plan.riskLevel,
      description: plan.approvalDescription,
      arguments: plan.approvalArguments,
      sessionId: context.sessionId,
      forceAsk: plan.approvalRequired,
    });

    if (approvalDecision?.action === "ask") {
      return this.executeBashAfterApproval(plan, call, context, approvalDecision);
    }
    if (!approvalDecision && plan.approvalRequired) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文不支持审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
      });
    }

    return this.bashTools.executePlan(plan, context);
  }

  private async executeBashAfterApproval(
    plan: BashExecutionPlan,
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    approvalDecision: RuntimeToolApprovalDecision,
  ): Promise<ToolExecutionResult> {
    const bashTools = this.bashTools;
    if (!bashTools) {
      return errorResult(`工具未暴露或暂未迁移: ${EXECUTE_BASH_TOOL_NAME}`, EXECUTE_BASH_TOOL_NAME);
    }
    const approvalMetadata = buildApprovalMetadata(approvalDecision);
    if (!this.pendingInteractions) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文不支持审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: approvalMetadata,
      });
    }

    const sessionId = context.sessionId?.trim();
    if (!sessionId) {
      return errorResult(`工具 ${EXECUTE_BASH_TOOL_NAME} 需要用户授权，但当前上下文无法等待审批`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: approvalMetadata,
      });
    }

    let resolution;
    try {
      resolution = await this.pendingInteractions.waitForApproval({
        sessionId,
        runId: context.runId,
        taskId: context.taskId,
        requestId: context.requestId,
        toolCallId: context.toolCallId ?? call.callId ?? null,
        agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
        approvalType: "bash_command",
        toolName: EXECUTE_BASH_TOOL_NAME,
        arguments: plan.approvalArguments,
        riskLevel: approvalDecision.riskLevel,
        description: approvalDecision.description,
        permissionMode: approvalDecision.permissionMode,
        approvalReason: approvalDecision.reason,
        approvalReasonCodes: approvalDecision.reasonCodes,
        approvalSecondaryReasons: approvalDecision.secondaryReasons,
        signal: context.signal,
      });
    } catch (error) {
      return errorResult(`审批流程异常: ${error instanceof Error ? error.message : String(error)}`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: approvalMetadata,
      });
    }

    if (!resolution.approved) {
      const denyReason = resolution.message || "用户拒绝执行此操作";
      return errorResult(`execute_bash 执行已被拒绝：${denyReason}`, EXECUTE_BASH_TOOL_NAME, {
        ...plan.metadata,
        approval: buildApprovalMetadata(approvalDecision, resolution.message),
      });
    }

    const result = await bashTools.executePlan(plan, context);
    return withApprovalMetadata(result, approvalDecision, resolution.message);
  }

  private async executeToolAfterApproval(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
    approvalDecision: RuntimeToolApprovalDecision,
  ): Promise<ToolExecutionResult> {
    const toolName = approvalDecision.toolName;
    const approvalMetadata = buildApprovalMetadata(approvalDecision);
    if (!this.pendingInteractions) {
      return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文不支持审批`, toolName, {
        approval: approvalMetadata,
      });
    }

    const sessionId = context.sessionId?.trim();
    if (!sessionId) {
      return errorResult(`工具 ${toolName} 需要用户授权，但当前上下文无法等待审批`, toolName, {
        approval: approvalMetadata,
      });
    }

    let resolution;
    try {
      resolution = await this.pendingInteractions.waitForApproval({
        sessionId,
        runId: context.runId,
        taskId: context.taskId,
        requestId: context.requestId,
        toolCallId: context.toolCallId ?? call.callId ?? null,
        agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
        approvalType: "tool_execution",
        toolName,
        arguments: call.arguments ?? {},
        riskLevel: approvalDecision.riskLevel,
        description: approvalDecision.description,
        permissionMode: approvalDecision.permissionMode,
        approvalReason: approvalDecision.reason,
        approvalReasonCodes: approvalDecision.reasonCodes,
        approvalSecondaryReasons: approvalDecision.secondaryReasons,
        signal: context.signal,
      });
    } catch (error) {
      return errorResult(`审批流程异常: ${error instanceof Error ? error.message : String(error)}`, toolName, {
        approval: approvalMetadata,
      });
    }

    if (!resolution.approved) {
      const denyReason = resolution.message || "用户拒绝执行此操作";
      return errorResult(`工具 ${toolName} 执行已被拒绝：${denyReason}`, toolName, {
        approval: buildApprovalMetadata(approvalDecision, resolution.message),
      });
    }

    const result = await this.executeAllowedTool(toolName, call, context);
    return withApprovalMetadata(result, approvalDecision, resolution.message);
  }

  private async requestUserInput(
    call: RuntimeToolCall,
    context: RuntimeToolExecutionContext,
  ): Promise<ToolExecutionResult<string>> {
    if (!this.pendingInteractions) {
      return errorResult("request_user_input 暂不可用", REQUEST_USER_INPUT_TOOL_NAME);
    }
    const prompt = readPrompt(call.arguments);
    if (!prompt) {
      return errorResult("request_user_input 缺少 prompt", REQUEST_USER_INPUT_TOOL_NAME);
    }
    if (!context.sessionId) {
      return successResult("", {
        summary: "当前上下文缺少 session_id，未等待用户输入",
        outputType: "text",
        metadata: {
          input_type: readInputType(call.arguments),
          options: readOptions(call.arguments),
          degraded: true,
        },
        toolName: REQUEST_USER_INPUT_TOOL_NAME,
      });
    }

    const startedAt = Date.now();
    const resolution = await this.pendingInteractions.waitForUserInput({
      sessionId: context.sessionId,
      runId: context.runId,
      taskId: context.taskId,
      requestId: context.requestId,
      toolCallId: context.toolCallId ?? call.callId ?? null,
      agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
      prompt,
      inputType: readInputType(call.arguments),
      options: readOptions(call.arguments),
      signal: context.signal,
    });

    return successResult(resolution.value, {
      summary: "用户输入已接收",
      outputType: "text",
      metadata: {
        input_id: resolution.inputId,
        input_type: readInputType(call.arguments),
        options: readOptions(call.arguments),
        degraded: false,
        waited_seconds: (Date.now() - startedAt) / 1000,
      },
      toolName: REQUEST_USER_INPUT_TOOL_NAME,
    });
  }
}

function buildToolCallContext(
  call: RuntimeToolCall,
  context: RuntimeToolExecutionContext,
): RuntimeToolExecutionContext {
  const callId = context.toolCallId ?? call.callId ?? null;
  if (callId === context.toolCallId) {
    return context;
  }
  return {
    ...context,
    toolCallId: callId,
  };
}

function readTaskCreateArguments(value: Record<string, unknown> | undefined): {
  subject: string;
  description: string;
  activeForm?: string | null;
  metadata?: Record<string, unknown> | null;
} {
  return {
    subject: asString(value?.subject) ?? "",
    description: asString(value?.description) ?? "",
    activeForm: asString(value?.active_form) ?? asString(value?.activeForm),
    metadata: asRecord(value?.metadata),
  };
}

function readTaskGetArguments(value: Record<string, unknown> | undefined): { taskId: string } {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
  };
}

function readTaskUpdateArguments(value: Record<string, unknown> | undefined): {
  taskId: string;
  subject?: string | null;
  description?: string | null;
  activeForm?: string | null;
  owner?: string | null;
  status?: string | null;
  addBlocks?: string[] | null;
  addBlockedBy?: string[] | null;
  metadata?: Record<string, unknown> | null;
} {
  const subject = asProvidedString(value, "subject");
  const description = asProvidedString(value, "description");
  const activeForm = asProvidedString(value, "active_form", "activeForm");
  const owner = asProvidedString(value, "owner");
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
    status: asString(value?.status),
    addBlocks: asStringArray(value?.add_blocks) ?? asStringArray(value?.addBlocks),
    addBlockedBy: asStringArray(value?.add_blocked_by) ?? asStringArray(value?.addBlockedBy),
    metadata: asRecord(value?.metadata),
    ...(subject !== undefined ? { subject } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(activeForm !== undefined ? { activeForm } : {}),
    ...(owner !== undefined ? { owner } : {}),
  };
}

function readTaskOutputArguments(value: Record<string, unknown> | undefined): {
  taskId: string;
  block?: boolean | null;
  timeout?: number | null;
  maxChars?: number | null;
} {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
    block: typeof value?.block === "boolean" ? value.block : null,
    timeout: asInteger(value?.timeout),
    maxChars: asInteger(value?.max_chars) ?? asInteger(value?.maxChars),
  };
}

function readTaskStopArguments(value: Record<string, unknown> | undefined): { taskId: string } {
  return {
    taskId: asString(value?.task_id) ?? asString(value?.taskId) ?? "",
  };
}

function readListMemoryIndexArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    scope: asString(value?.scope) ?? "",
    sessionId: asString(value?.session_id) ?? asString(value?.sessionId),
    agentName: asString(value?.agent_name) ?? asString(value?.agentName),
    workspaceKey: asString(value?.workspace_key) ?? asString(value?.workspaceKey),
    currentAgentName: asString(value?.current_agent_name) ?? asString(value?.currentAgentName),
    teamName: asString(value?.team_name) ?? asString(value?.teamName),
    workspaceRoot: asString(value?.workspace_root) ?? asString(value?.workspaceRoot),
  };
}

function readMemoryEntryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  fileName: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    ...readListMemoryIndexArguments(value),
    fileName: asString(value?.file_name) ?? asString(value?.fileName) ?? "",
  };
}

function readWriteMemoryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  name: string;
  description: string;
  memoryType: string;
  content: string;
  why?: string | null;
  howToApply?: string | null;
  sourceRunId?: string | null;
  sourceMessageId?: string | null;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return {
    ...readListMemoryIndexArguments(value),
    name: asString(value?.name) ?? "",
    description: asString(value?.description) ?? "",
    memoryType: asString(value?.memory_type) ?? asString(value?.memoryType) ?? "",
    content: typeof value?.content === "string" ? value.content : "",
    why: asString(value?.why),
    howToApply: asString(value?.how_to_apply) ?? asString(value?.howToApply),
    sourceRunId: asString(value?.source_run_id) ?? asString(value?.sourceRunId),
    sourceMessageId: asString(value?.source_message_id) ?? asString(value?.sourceMessageId),
  };
}

function readArchiveMemoryArguments(value: Record<string, unknown> | undefined): {
  scope: string;
  fileName: string;
  sessionId?: string | null;
  agentName?: string | null;
  workspaceKey?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
} {
  return readMemoryEntryArguments(value);
}

function readFileArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  encoding?: string | null;
  offset?: number | null;
  limit?: number | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    encoding: asString(value?.encoding),
    offset: asInteger(value?.offset),
    limit: asInteger(value?.limit),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function writeFileArguments(value: Record<string, unknown> | undefined): {
  content: unknown;
  filePath?: string | null;
  encoding?: string | null;
  mode?: string | null;
  filePathSpace?: string | null;
} {
  return {
    content: value?.content ?? "",
    filePath: asString(value?.file_path) ?? asString(value?.filePath),
    encoding: asString(value?.encoding),
    mode: asString(value?.mode),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function editFileArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  oldString: string;
  newString: string;
  encoding?: string | null;
  replaceAll?: boolean | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    oldString: asString(value?.old_string) ?? asString(value?.oldString) ?? "",
    newString: typeof value?.new_string === "string" ? value.new_string : typeof value?.newString === "string" ? value.newString : "",
    encoding: asString(value?.encoding),
    replaceAll: typeof value?.replace_all === "boolean" ? value.replace_all : typeof value?.replaceAll === "boolean" ? value.replaceAll : null,
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function previewDataStructureArguments(value: Record<string, unknown> | undefined): {
  filePath: string;
  encoding?: string | null;
  maxPreviewRows?: number | null;
  maxDepth?: number | null;
  maxFields?: number | null;
  filePathSpace?: string | null;
} {
  return {
    filePath: asString(value?.file_path) ?? asString(value?.filePath) ?? "",
    encoding: asString(value?.encoding),
    maxPreviewRows: asInteger(value?.max_preview_rows) ?? asInteger(value?.maxPreviewRows),
    maxDepth: asInteger(value?.max_depth) ?? asInteger(value?.maxDepth),
    maxFields: asInteger(value?.max_fields) ?? asInteger(value?.maxFields),
    filePathSpace: asString(value?.file_path_space) ?? asString(value?.filePathSpace),
  };
}

function readBashArguments(value: Record<string, unknown> | undefined): BashExecutionInput {
  return {
    command: asString(value?.command) ?? "",
    workingDir: asString(value?.working_dir) ?? asString(value?.workingDir),
    workingDirSpace: asString(value?.working_dir_space) ?? asString(value?.workingDirSpace),
    timeout: asInteger(value?.timeout),
    runInBackground: typeof value?.run_in_background === "boolean"
      ? value.run_in_background
      : typeof value?.runInBackground === "boolean"
        ? value.runInBackground
        : null,
    description: asString(value?.description),
  };
}

function readCallAgentArguments(value: Record<string, unknown> | undefined, callId: string | undefined): {
  agentName: string;
  task: string;
  contextHint?: string | null;
  callId?: string | null;
} {
  return {
    agentName: asString(value?.agent_name) ?? asString(value?.agentName) ?? "",
    task: asString(value?.task) ?? "",
    contextHint: asString(value?.context_hint) ?? asString(value?.contextHint),
    callId: callId ?? null,
  };
}

function readListChildAgentsArguments(value: Record<string, unknown> | undefined): {
  agentName?: string | null;
  limit?: number | null;
} {
  return {
    agentName: asString(value?.agent_name) ?? asString(value?.agentName),
    limit: asInteger(value?.limit),
  };
}

function readSendMessageArguments(value: Record<string, unknown> | undefined, callId: string | undefined): {
  childAgentId: string;
  message: string;
  callId?: string | null;
} {
  return {
    childAgentId: asString(value?.child_agent_id) ?? asString(value?.childAgentId) ?? "",
    message: asString(value?.message) ?? "",
    callId: callId ?? null,
  };
}

function errorResult(
  message: string,
  toolName: string,
  metadata: Record<string, unknown> = {},
): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
      ...metadata,
    },
    artifacts: [],
    llm_hint: null,
  };
}

function successResult<T>(
  content: T,
  input: {
    summary: string;
    outputType: string;
    metadata: Record<string, unknown>;
    toolName: string;
  },
): ToolExecutionResult<T> {
  return {
    success: true,
    tool_name: input.toolName,
    summary: input.summary,
    answer: null,
    output_type: input.outputType,
    content,
    metadata: input.metadata,
    artifacts: [],
    llm_hint: null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asProvidedString(value: Record<string, unknown> | undefined, ...keys: string[]): string | null | undefined {
  if (!value) {
    return undefined;
  }
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      return typeof value[key] === "string" ? value[key] : null;
    }
  }
  return undefined;
}

function asInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  return value.map((item) => String(item)).filter((item) => item.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readPrompt(value: Record<string, unknown> | undefined): string | null {
  return asString(value?.prompt) ?? asString(value?.question) ?? asString(value?.message);
}

function readInputType(value: Record<string, unknown> | undefined): string {
  return asString(value?.input_type) === "select" ? "select" : "text";
}

function readOptions(value: Record<string, unknown> | undefined): string[] {
  if (!Array.isArray(value?.options)) {
    return [];
  }
  return value.options.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

function buildApprovalMetadata(
  decision: RuntimeToolApprovalDecision,
  note = "",
): Record<string, unknown> {
  return {
    reason: decision.reason,
    note,
    ...(decision.reasonCodes.length ? { reason_codes: decision.reasonCodes } : {}),
    ...(decision.secondaryReasons.length ? { secondary_reasons: decision.secondaryReasons } : {}),
  };
}

function withApprovalMetadata<T>(
  result: ToolExecutionResult<T>,
  decision: RuntimeToolApprovalDecision,
  note: string,
): ToolExecutionResult<T> {
  return {
    ...result,
    metadata: {
      ...result.metadata,
      approval: buildApprovalMetadata(decision, note),
      ...(note ? { approval_message: note } : {}),
    },
  };
}

export function isReadOnlyMemoryToolName(toolName: string): toolName is ReadOnlyMemoryToolName {
  return READ_ONLY_MEMORY_TOOL_NAMES.includes(toolName as ReadOnlyMemoryToolName);
}
