import type { AgentConfig } from "../../contracts/agent-config.js";
import type { RiskLevel } from "../../contracts/permissions.js";

export interface ToolExecutionResult<T = unknown> {
  success: boolean;
  tool_name: string;
  summary: string;
  answer: string | null;
  output_type: string;
  content: T;
  metadata: Record<string, unknown>;
  artifacts: unknown[];
  llm_hint: string | null;
}

export interface RuntimeToolCall {
  toolName: string;
  arguments?: Record<string, unknown> | undefined;
  callId?: string | undefined;
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  allowed_callers?: Array<"direct" | "code_execution" | string> | undefined;
  returns?: RuntimeToolReturns | undefined;
  usage_contract?: string[] | undefined;
  examples?: RuntimeToolExample[] | undefined;
  extended_usage?: string | undefined;
  source?: "runtime_builtin" | "memory" | "document" | "execution" | "agent_tool" | "knowledge" | "mcp" | undefined;
  category?: string | undefined;
  riskLevel?: RiskLevel | undefined;
  approvalExempt?: boolean | undefined;
}

export interface RuntimeToolReturns {
  description?: string | undefined;
  shape?: unknown;
}

export type RuntimeToolExample = Record<string, unknown>;

export interface RuntimeToolExecutionContext {
  agent: AgentConfig | null;
  caller?: "direct" | "code_execution" | string | undefined;
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
  classifyConcurrency?(call: RuntimeToolCall, context: RuntimeToolExecutionContext): boolean;
  waitForToolResult?(
    request: RuntimeToolWaitRequest,
    context: RuntimeToolExecutionContext,
  ): RuntimeToolWaitResult | Promise<RuntimeToolWaitResult>;
}
