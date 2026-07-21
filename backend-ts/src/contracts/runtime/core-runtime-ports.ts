import type {
  ChildAgentInfo,
  IChildAgentStore,
  IMessageStore,
  IMetricStore,
  IRunStore,
  OutboxRow,
  RunInfo,
} from "../conversation-store/index.js";
import type { PermissionMode } from "./permissions.js";
import type { MessageInfo } from "../session/session.js";
import type { Envelope } from "../events.js";
import type { IFileIndexStore } from "../file-index-store/index.js";
import type { AsyncSessionFileStorage } from "../session/session-file-storage.js";

/** Values returned by the Local adapter may be synchronous; SaaS adapters are async. */
export type Awaitable<T> = T | Promise<T>;

/** Deployment-neutral durable event delivery surface. */
export interface RuntimeEventDispatcherPort {
  dispatchRows(rows: OutboxRow[]): Awaitable<Envelope[]>;
}

/** Explicit attachment source selected by a deployment composition root. */
export type RuntimeSessionFilesPort =
  | { kind: "local"; fileIndex: IFileIndexStore }
  | { kind: "async"; storage: AsyncSessionFileStorage };

/** Persistence surface required by child-agent delegation.
 *
 * Every operation is awaitable so the shared delegation service cannot accidentally
 * make a PostgreSQL call look synchronous. Local's synchronous ConversationStore
 * remains source-compatible because plain values are valid Awaitables.
 */
export interface AgentDelegationStorePort {
  addMessage(input: Parameters<IMessageStore["addMessage"]>[0]): Awaitable<MessageInfo>;
  getRecentMessages(sessionId: string, limit?: number, threadKey?: string | null): Awaitable<MessageInfo[]>;
  getRun(sessionId: string, runId: string): Awaitable<RunInfo | null>;
  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId?: string | null): Awaitable<boolean>;
  createChildAgent(input: Parameters<IChildAgentStore["createChildAgent"]>[0]): Awaitable<ChildAgentInfo>;
  findChildAgentByCreator(input: Parameters<IChildAgentStore["findChildAgentByCreator"]>[0]): Awaitable<ChildAgentInfo | null>;
  getChildAgent(sessionId: string, childAgentId: string): Awaitable<ChildAgentInfo | null>;
  listChildAgents(input: Parameters<IChildAgentStore["listChildAgents"]>[0]): Awaitable<ReturnType<IChildAgentStore["listChildAgents"]>>;
  updateChildAgentLastRun(input: Parameters<IChildAgentStore["updateChildAgentLastRun"]>[0]): Awaitable<boolean>;
}

/** Metrics persistence may be synchronous (Local) or asynchronous (SaaS/PG). */
export interface AgentMetricsStorePort {
  insertMetric(input: Parameters<IMetricStore["insertMetric"]>[0]): Awaitable<void>;
  aggregateMetrics(agentName?: string | null): Awaitable<ReturnType<IMetricStore["aggregateMetrics"]>>;
  resetMetrics(agentName?: string | null): Awaitable<ReturnType<IMetricStore["resetMetrics"]>>;
}

/** Local synchronous fallback for context compression history. */
export type CompressionHistoryStorePort = Pick<
  IMessageStore,
  "getRecentMessages" | "insertCompressionMessage"
>;

/** Session projection required to resolve a run's permission mode. */
export interface PermissionPolicyStorePort {
  /** Synchronous snapshot read used by the SDK gate hook. */
  getSession(sessionId: string): { permission_mode?: PermissionMode | null } | null;
  /** Optional async refresh from the deployment's authoritative store. */
  prepareSession?(sessionId: string): Promise<void>;
}
