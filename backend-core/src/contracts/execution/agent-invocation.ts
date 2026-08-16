import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type { ThinkingLevel } from "@ragsystem/agent-llm";

import type { AgentConfig } from "../agent/agent-config.js";
import type { Envelope } from "../events.js";
import type { ModelProviderConfig } from "../integrations/model-adapter.js";
import type { InteractionRequiredNotice } from "../runtime/pending-interactions.js";
import type { SessionIdentity } from "../session/session.js";
import type { ExecutionStartDisposition } from "./execution-storage.js";

export type AgentInvocationMode = "create" | "resume";

interface AgentInvocationBase {
  execution: "foreground" | "background";
  sessionId: string;
  sessionIdentity: SessionIdentity;
  requestId: string;
  task: string;
  executionKind: string;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  selectedLlm?: { provider: ModelProviderConfig; modelName: string } | null;
  /** 请求级思考档位（前端 thinking_level）；undefined = 跟随 agent tier 默认档位。 */
  thinkingLevel?: ThinkingLevel;
  /** Existing run/call used to claim durable agent messages during an idle continuation. */
  mailboxTargetRunId?: string | null;
  mailboxTargetAgentCallId?: string | null;
  /** Abort this invocation after the requested wall-clock duration. */
  timeoutMs?: number | null;
}

export interface AgentInvocationRootInput extends AgentInvocationBase {
  scope: "root";
  mode: AgentInvocationMode;
  runId?: string;
  taskId?: string;
  rootCallId?: string;
  userId?: string | null;
  modelTask?: string;
  entrypoint?: string;
  persistUserMessage?: {
    metadata?: Record<string, unknown>;
    contentParts: MessageContentPart[];
    inputType?: "user_message" | "system_notification" | "goal_continuation";
    sourceKind?: "user" | "system";
    visibleToUser?: boolean;
  };
  /** Existing durable mailbox input that canonically starts this root Run. */
  rootMailboxMessage?: {
    id: string;
    inputType: "user_message" | "agent_message" | "system_notification" | "goal_continuation";
    sourceKind: "user" | "agent" | "system";
    visibleToUser: boolean;
    sentAt: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown>;
  };
  followupPolicy?: "queue" | "reject";
  sessionMaintenanceToken?: string;
  awaitFollowupCompletion?: boolean;
  runStartExtra?: Record<string, unknown>;
  startStepExtra?: Record<string, unknown>;
  finalMetadataExtra?: Record<string, unknown>;
  onInteractionRequired?: (notice: InteractionRequiredNotice) => void;
}

export interface AgentInvocationChildInput extends AgentInvocationBase {
  scope: "child";
  mode: AgentInvocationMode;
  runId: string;
  taskId: string;
  rootCallId: string;
  startedAt: Date;
  signal?: AbortSignal;
  threadKey: string;
  rootRunId?: string;
  interactionRootCallId?: string;
  lineageParentCallId?: string | null;
  parentRunId?: string | null;
  parentCallId?: string | null;
  childAgentId?: string | null;
  /** Canonical message that starts a newly-created child Run. */
  initialMessage?: {
    id: string;
    content: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown>;
  };
  /** Expected durable participant pointer replaced by this newly-created Run. */
  participantExpectedLastRunId?: string | null;
  initialMailboxMessageId?: string | null;
  ownsRunLease?: boolean;
  userId?: string | null;
  sessionMaintenanceToken?: string;
  initialEnvelopes?: readonly Envelope[];
  rootTask?: string;
  finalMetadataExtra?: Record<string, unknown>;
  onInteractionRequired?: (notice: InteractionRequiredNotice) => void;
  onStartDisposition?: (disposition: ExecutionStartDisposition) => void;
  onTerminal?: (finalStatus: "completed" | "failed" | "interrupted" | "suspended") => void;
}

export type AgentInvocationRequest = AgentInvocationRootInput | AgentInvocationChildInput;

export interface AgentInvocationOutcome {
  content: string;
  success: boolean;
  runId: string;
  interrupted?: boolean;
  contentParts?: MessageContentPart[];
  suspended?: boolean;
  interactionKind?: "approval" | "user_input";
  followup?: Extract<ExecutionStartDisposition, { kind: "followup" }>;
  followupJoined?: boolean;
  followupFailed?: boolean;
}

export interface AgentInvocationHandle {
  started: boolean;
  session_id: string;
  run_id: string;
  task_id: string;
  request_id: string;
  kind: "agent_run";
  promise: Promise<AgentInvocationOutcome>;
  durableStarted: Promise<ExecutionStartDisposition>;
}

export interface AgentInvocationPort {
  invoke(input: AgentInvocationRequest): AgentInvocationHandle;
}
