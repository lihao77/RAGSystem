import type {
  AddMessageInput,
  AgentMetricSummary,
  ChildAgentInfo,
  ClaimOutboxInput,
  CreateChildAgentInput,
  FindChildAgentByCreatorInput,
  ListChildAgentsInput,
  OutboxRow,
  RunInfo,
  UpdateChildAgentLastRunInput,
} from "../conversation-store/index.js";
import type { PermissionMode } from "./permissions.js";
import type { MessageInfo, SessionInfo } from "../session/session.js";
import type { Envelope } from "../events.js";
import type { RuntimeRecordEnvelopeInput } from "../storage/runtime-storage.js";

export type {
  CreateChildAgentInput,
  FindChildAgentByCreatorInput,
  ListChildAgentsInput,
  UpdateChildAgentLastRunInput,
} from "../conversation-store/index.js";

export interface ClientEventPublishOptions {
  runId?: string | null | undefined;
  aggregateType?: string | undefined;
  aggregateId?: string | undefined;
  eventType?: string | undefined;
  eventId?: string | undefined;
  requireRunLease?: boolean | undefined;
}

/** Deployment-neutral, Promise-only durable client-event surface. */
export interface ClientEventPublisherPort {
  publish(sessionId: string, event: Envelope, options?: ClientEventPublishOptions): Promise<OutboxRow>;
  record(sessionId: string, event: Envelope, options?: ClientEventPublishOptions): Promise<OutboxRow>;
  prepare(sessionId: string, event: Envelope, options?: ClientEventPublishOptions): RuntimeRecordEnvelopeInput;
  flush(sessionId: string): Promise<void>;
  deliver(rows: OutboxRow[]): Promise<void>;
}

/** Deployment-neutral, Promise-only durable event delivery surface. */
export interface RuntimeEventDispatcherPort {
  dispatchRows(rows: OutboxRow[]): Promise<Envelope[]>;
  dispatchPendingRows?(rows: OutboxRow[]): Promise<Envelope[]>;
}

/** Persistence required by the dispatcher; targeted claiming is a multi-instance capability. */
export interface OutboxDispatchStorePort {
  claimPendingOutbox(input?: ClaimOutboxInput): Promise<OutboxRow[]>;
  claimOutboxRows?(input: {
    ids: readonly number[];
    tenantId?: string;
    lockTimeoutMs?: number;
    now?: Date;
  }): Promise<OutboxRow[]>;
  markOutboxDelivered(id: number, tenantId: string): Promise<boolean>;
  markOutboxRetrying(id: number, error: string, availableAt: string, tenantId: string): Promise<boolean>;
  markOutboxFailed(id: number, error: string, tenantId: string): Promise<boolean>;
}

/** Promise-only persistence surface required by child-agent delegation. */
export interface AgentDelegationStorePort {
  getSession(sessionId: string): Promise<SessionInfo | null>;
  addMessage(input: AddMessageInput): Promise<MessageInfo>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  getRun(sessionId: string, runId: string): Promise<RunInfo | null>;
  listRuns(sessionId: string, limit?: number): Promise<{ items: RunInfo[]; total: number }>;
  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId?: string | null, terminalReason?: string | null): Promise<boolean>;
  createChildAgent(input: CreateChildAgentInput): Promise<ChildAgentInfo>;
  findChildAgentByCreator(input: FindChildAgentByCreatorInput): Promise<ChildAgentInfo | null>;
  getChildAgent(sessionId: string, childAgentId: string): Promise<ChildAgentInfo | null>;
  listChildAgents(input: ListChildAgentsInput): Promise<{ items: ChildAgentInfo[]; total: number }>;
  updateChildAgentLastRun(input: UpdateChildAgentLastRunInput): Promise<boolean>;
}

export interface AgentMetricInput {
  agentName: string;
  model?: string;
  sessionId?: string | null;
  runId?: string | null;
  taskId?: string | null;
  executionKind: string;
  status: string;
  durationMs: number;
  tokenIn?: number;
  tokenOut?: number;
  toolUsage?: Record<string, number>;
  errorType?: string | null;
  startedAt: string;
  finishedAt?: string | null;
}

/** Promise-only metrics persistence surface. */
export interface AgentMetricsStorePort {
  insertMetric(input: AgentMetricInput): Promise<void>;
  aggregateMetrics(agentName?: string | null): Promise<AgentMetricSummary[]>;
  resetMetrics(agentName?: string | null): Promise<{ deleted: number }>;
}

/** Durable history required by context compression. */
export interface InsertCompressionMessageInput {
  sessionId: string;
  summaryContent: string;
  replacesUpToSeq?: number | null;
  threadKey?: string;
  childAgentId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CompressionHistoryPort {
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Promise<MessageInfo[]>;
  insertCompressionMessage(input: InsertCompressionMessageInput): Promise<MessageInfo>;
}

/** Session projection required to resolve a run's permission mode. */
export interface PermissionPolicyStorePort {
  /** Synchronous snapshot read used by the SDK gate hook. */
  getSession(sessionId: string): { permission_mode?: PermissionMode | null } | null;
  /** Optional async refresh from the deployment's authoritative store. */
  prepareSession?(sessionId: string): Promise<void>;
}
