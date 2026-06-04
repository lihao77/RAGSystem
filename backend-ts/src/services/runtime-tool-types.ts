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
}

export interface RuntimeToolExecutionContext {
  agent: AgentConfig | null;
  sessionId?: string | null;
  currentAgentName?: string | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
}

export interface RuntimeToolExecutor {
  listVisibleTools(agent: AgentConfig | null): RuntimeToolDefinition[];
  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult;
}
