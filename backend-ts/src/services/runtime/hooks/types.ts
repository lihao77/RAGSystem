import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { RiskLevel } from "../../../contracts/permissions.js";
import type { RuntimeToolCall, RuntimeToolExecutionContext, ToolExecutionResult } from "../runtime-tool-types.js";

export type HookEventName =
  | "tool.before_permission"
  | "tool.after_permission"
  | "tool.before_execute"
  | "tool.after_execute"
  | "tool.on_error"
  | "approval.required"
  | "approval.resolved"
  | "approval.denied"
  | "approval.error";

export type HookPhase =
  | "before_permission"
  | "after_permission"
  | "before_execute"
  | "after_execute"
  | "on_error"
  | "approval_required"
  | "approval_resolved"
  | "approval_denied"
  | "approval_error";

export type WorkspaceTrustValue = "trusted" | "untrusted";
export type HookPermissionDecision = "allow" | "ask" | "deny";

export interface HookContext {
  eventName: HookEventName;
  phase: HookPhase;
  timestamp: number;
  sessionId: string | null;
  runId: string | null;
  requestId: string | null;
  agent: AgentConfig | null;
  agentName: string | null;
  agentDisplayName: string | null;
  caller: string;
  userRole: string | null;
  toolName: string | null;
  toolCallId: string | null;
  parentCallId: string | null;
  round: number | null;
  order: number | null;
  roundIndex: number | null;
  workspaceTrust: WorkspaceTrustValue;
  source: string;
  inputSnapshot: Record<string, unknown>;
  resultSnapshot: Record<string, unknown>;
  errorSnapshot: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

export interface HookResult {
  continueExecution: boolean;
  blockExecution: boolean;
  blockReason: string;
  permissionDecision?: HookPermissionDecision | null;
  additionalContext?: string[] | undefined;
  uiMessage?: string | null | undefined;
  uiMetadata?: Record<string, unknown> | undefined;
  tags?: string[] | undefined;
  metadata?: Record<string, unknown> | undefined;
  broadcastProgress?: string | null | undefined;
}

export interface HookMatcher {
  toolNames?: string[] | undefined;
  agentNames?: string[] | undefined;
  callers?: string[] | undefined;
  riskLevels?: RiskLevel[] | undefined;
  workspaceTrust?: WorkspaceTrustValue[] | undefined;
  sessionIds?: string[] | undefined;
  userRoles?: string[] | undefined;
  whenResultSuccess?: boolean | null | undefined;
  whenPermissionMode?: string[] | undefined;
  sources?: string[] | undefined;
  tags?: string[] | undefined;
}

export interface HookBackendDefinition {
  type: "function" | "prompt" | "callback";
  target: string;
  config?: Record<string, unknown> | undefined;
}

export interface HookDefinition {
  id: string;
  name: string;
  description?: string | undefined;
  enabled?: boolean | undefined;
  source?: "system" | "agent" | "session" | string | undefined;
  priority?: number | undefined;
  events: HookEventName[];
  matcher?: HookMatcher | undefined;
  backend: HookBackendDefinition;
  ifExpr?: string | undefined;
  timeoutMs?: number | undefined;
  failOpen?: boolean | undefined;
  uiTitle?: string | null | undefined;
  uiDescription?: string | null | undefined;
  broadcast?: boolean | undefined;
  tags?: string[] | undefined;
}

export interface WorkspaceTrustRule {
  workspaceRootPrefix: string;
  trust: WorkspaceTrustValue;
}

export interface WorkspaceTrustConfig {
  default: WorkspaceTrustValue;
  rules: WorkspaceTrustRule[];
}

export interface HookHandlerInput {
  context: HookContext;
  config: Record<string, unknown>;
}

export type HookHandler = (input: HookHandlerInput) => HookResult | Promise<HookResult>;

export interface RuntimeHookToolInput {
  toolName: string;
  tool?: {
    riskLevel?: RiskLevel | null | undefined;
    source?: string | undefined;
  } | null | undefined;
  call: RuntimeToolCall;
  context: RuntimeToolExecutionContext;
  permissionDecision?: {
    action: "allow" | "ask";
    permissionMode?: string | null | undefined;
    riskLevel?: RiskLevel | null | undefined;
  } | null | undefined;
  result?: ToolExecutionResult | null | undefined;
  error?: unknown;
}
