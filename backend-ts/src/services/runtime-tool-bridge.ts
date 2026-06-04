import type { AgentConfig } from "../contracts/agent-config.js";
import {
  type MemoryToolRuntimeContext,
  type ToolExecutionResult,
  type MemoryToolService,
} from "./memory-tool-service.js";

export interface RuntimeToolCall {
  toolName: string;
  arguments?: Record<string, unknown> | undefined;
}

export type RuntimeToolExecutionContext = MemoryToolRuntimeContext;

const READ_ONLY_MEMORY_TOOL_NAMES = ["list_memory_index", "read_memory_entry"] as const;
type ReadOnlyMemoryToolName = (typeof READ_ONLY_MEMORY_TOOL_NAMES)[number];

export class RuntimeToolBridge {
  constructor(private readonly memoryTools: MemoryToolService) {}

  listVisibleToolNames(agent: AgentConfig | null): string[] {
    const memoryConfig = agent?.memory;
    if (memoryConfig?.allowed_scopes?.length) {
      return [...READ_ONLY_MEMORY_TOOL_NAMES];
    }
    return [];
  }

  canExecuteTool(toolName: string, agent: AgentConfig | null): boolean {
    return this.listVisibleToolNames(agent).includes(toolName);
  }

  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult {
    const toolName = call.toolName.trim();
    if (!this.canExecuteTool(toolName, context.agent)) {
      return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName || "unknown");
    }
    if (toolName === "list_memory_index") {
      return this.memoryTools.listMemoryIndex(readListMemoryIndexArguments(call.arguments), context);
    }
    if (toolName === "read_memory_entry") {
      return this.memoryTools.readMemoryEntry(readMemoryEntryArguments(call.arguments), context);
    }
    return errorResult(`工具未暴露或暂未迁移: ${toolName}`, toolName);
  }
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

function errorResult(message: string, toolName: string): ToolExecutionResult<string> {
  return {
    success: false,
    tool_name: toolName,
    summary: message,
    answer: null,
    output_type: "error",
    content: message,
    metadata: {
      source_shape: "error",
    },
    artifacts: [],
    llm_hint: null,
  };
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function isReadOnlyMemoryToolName(toolName: string): toolName is ReadOnlyMemoryToolName {
  return READ_ONLY_MEMORY_TOOL_NAMES.includes(toolName as ReadOnlyMemoryToolName);
}
