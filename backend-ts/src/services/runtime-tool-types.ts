import type { AgentConfig } from "../contracts/agent-config.js";
import type { ToolExecutionResult } from "./memory-tool-service.js";

export interface RuntimeToolCall {
  toolName: string;
  arguments?: Record<string, unknown> | undefined;
  callId?: string | undefined;
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  source?: "runtime_builtin" | "memory" | "agent_tool" | "mcp" | undefined;
  category?: string | undefined;
}

export interface RuntimeToolExecutionContext {
  agent: AgentConfig | null;
  sessionId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  requestId?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
  signal?: AbortSignal | undefined;
}

export interface RuntimeToolExecutor {
  listVisibleTools(agent: AgentConfig | null): RuntimeToolDefinition[];
  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult>;
}
