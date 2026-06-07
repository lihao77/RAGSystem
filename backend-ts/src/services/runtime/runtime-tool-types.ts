import type { AgentConfig } from "../../contracts/agent-config.js";
import type { RiskLevel } from "../../contracts/permissions.js";
import type { ToolExecutionResult } from "../tools/memory-tool-service.js";

export interface RuntimeToolCall {
  toolName: string;
  arguments?: Record<string, unknown> | undefined;
  callId?: string | undefined;
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  source?: "runtime_builtin" | "memory" | "document" | "execution" | "agent_tool" | "mcp" | undefined;
  category?: string | undefined;
  riskLevel?: RiskLevel | undefined;
  approvalExempt?: boolean | undefined;
}

export interface RuntimeToolExecutionContext {
  agent: AgentConfig | null;
  sessionId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  requestId?: string | null;
  currentAgentName?: string | null;
  parentCallId?: string | null;
  toolCallId?: string | null;
  round?: number | null;
  order?: number | null;
  roundIndex?: number | null;
  teamName?: string | null;
  workspaceRoot?: string | null;
  approvedExternalPaths?: string[] | undefined;
  signal?: AbortSignal | undefined;
}

export interface RuntimeToolWaitRequest {
  backgroundTaskId: string;
  timeoutMs?: number | null | undefined;
}

export interface RuntimeToolWaitResult {
  success: boolean;
  timeout: boolean;
  payloads: Array<Record<string, unknown>>;
}

export interface RuntimeToolExecutor {
  listVisibleTools(agent: AgentConfig | null): RuntimeToolDefinition[];
  executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext): ToolExecutionResult | Promise<ToolExecutionResult>;
  waitForToolResult?(
    request: RuntimeToolWaitRequest,
    context: RuntimeToolExecutionContext,
  ): RuntimeToolWaitResult | Promise<RuntimeToolWaitResult>;
}
