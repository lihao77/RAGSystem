import type { MessageInfo } from "../../../contracts/session.js";
import type { SessionOps } from "./session-ops.js";
import type { MessageOps } from "./message-ops.js";
import type { RunOps } from "./run-ops.js";
import type { ChildAgentOps } from "./child-agent-ops.js";
import type { OutboxOps } from "./outbox-ops.js";
import type { ResourceOps } from "./resource-ops.js";
import type { ConversationStoreTransaction } from "./types.js";

/**
 * 会话存储窄接口：按聚合根拆分，调用方只依赖它真正使用的域（类似 tool 调用方
 * 经 registry 只见需要的能力）。接口用 Pick 从 ops 派生，签名自动跟随实现。
 */

/** sessions 聚合根。 */
export type ISessionStore = Pick<
  SessionOps,
  "createSession" | "getSession" | "updateSessionMetadata" | "deleteSession" | "listSessions"
>;

/** messages 聚合根。 */
export type IMessageStore = Pick<
  MessageOps,
  | "addMessage"
  | "insertCompressionMessage"
  | "listMessages"
  | "getMessageBySeq"
  | "getMessageById"
  | "getFirstMessageAfterSeq"
  | "listMessagesAfterSeq"
  | "listMessagesBeforeOrAtSeq"
  | "getRecentMessages"
  | "deleteMessagesAfter"
  | "updateMessage"
>;

/** runs + run_steps 聚合根。 */
export type IRunStore = Pick<
  RunOps,
  | "createRun"
  | "updateRunStatus"
  | "getRun"
  | "listRuns"
  | "addRunStep"
  | "updateRunStepsMessageId"
  | "listRunSteps"
  | "getToolCallRawResult"
>;

/** child_agents 聚合根。 */
export type IChildAgentStore = Pick<
  ChildAgentOps,
  "createChildAgent" | "listChildAgents" | "getChildAgent" | "updateChildAgentLastRun"
>;

/** event_outbox 聚合根。 */
export type IOutboxStore = Pick<
  OutboxOps,
  | "getNextSessionSeq"
  | "appendOutbox"
  | "fetchPendingOutbox"
  | "claimPendingOutbox"
  | "listOutboxForReplay"
  | "getOutboxRow"
  | "listOutbox"
  | "markOutboxDelivered"
  | "markOutboxRetrying"
  | "markOutboxFailed"
  | "retryOutbox"
  | "retryOutboxBatch"
  | "deleteDeliveredOutbox"
  | "getOutboxStats"
>;

/** resources 聚合根。 */
export type IResourceStore = Pick<
  ResourceOps,
  "getPersistedExecutionOverview" | "registerResource" | "listResources" | "attachResourceToStep"
>;

/** 跨域事务运行器（事务原子性独立成契，不可按域拆分）。 */
export interface IConversationTransactionRunner {
  runInTransaction<T>(operation: (tx: ConversationStoreTransaction) => T): T;
}

/**
 * 聚合 store 组合（向后兼容历史 ConversationStore 接口）。
 * close + getRecentMessagesByChildAgent 是组合根级能力（跨域/生命周期），不属单一窄接口。
 */
export type ConversationStore = ISessionStore &
  IMessageStore &
  IRunStore &
  IChildAgentStore &
  IOutboxStore &
  IResourceStore &
  IConversationTransactionRunner & {
    close(): void;
    getRecentMessagesByChildAgent(sessionId: string, childAgentId: string, limit?: number): MessageInfo[];
  };
