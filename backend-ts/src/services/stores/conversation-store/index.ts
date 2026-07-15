import { createConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { SessionOps } from "./session-ops.js";
import { MessageOps, DEFAULT_MESSAGE_LIST_LIMIT } from "./message-ops.js";
import { RunOps } from "./run-ops.js";
import { ChildAgentOps } from "./child-agent-ops.js";
import { OutboxOps } from "./outbox-ops.js";
import { ResourceOps } from "./resource-ops.js";
import { MetricOps } from "./metric-ops.js";
import type {
  ConversationStore,
  ConversationStoreOptions,
  ConversationStoreTransaction,
} from "../../../contracts/conversation-store/index.js";

// IXxxStore 窄契约与 DTO 已上移至 contracts/conversation-store/，消费者改向该处 import。
// 本文件仅保留 ConversationStore 聚合类型转出（见末尾），供 runtime-container 组装使用。

/**
 * 组装会话存储（无主类）：创建共享 SQLite 句柄 + 6 个聚合根 ops，组合为统一 facade。
 * 类比 tools 的 createXxxTools(deps) / agent 的 createAgentExecutionService(params) 工厂。
 * ops 方法通过 bind 绑定 this；跨域方法（getRecentMessagesByChildAgent / 事务 facade）显式协调。
 * 对外契约（ConversationStore 类型）与历史完全一致。
 */
export function createConversationStore(options: ConversationStoreOptions) {
  const { db, dataRoot } = createConversationDb({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const sessions = new SessionOps(db);
  const messages = new MessageOps(db);
  const runs = new RunOps(db);
  const childAgents = new ChildAgentOps(db);
  const outbox = new OutboxOps(db);
  const resources = new ResourceOps(db, dataRoot, sessions);
  const metrics = new MetricOps(db);

  const createTransactionFacade = (): ConversationStoreTransaction => ({
    addMessage: messages.addMessageInTransaction.bind(messages),
    addRunStep: runs.addRunStepInTransaction.bind(runs),
    updateRunStepsMessageId: runs.updateRunStepsMessageId.bind(runs),
    updateRunStatus: runs.updateRunStatus.bind(runs),
    nextSessionSeq: outbox.nextSessionSeqInTransaction.bind(outbox),
    appendOutbox: outbox.appendOutboxInTransaction.bind(outbox),
    // 纯读、不开新事务（listMessages 仅 SELECT），事务内读消除 TOCTOU，故直接 bind 无需 InTransaction 变体。
    getRecentMessages: messages.getRecentMessages.bind(messages),
  });

  return {
    close: () => db.close(),

    // session
    createSession: sessions.createSession.bind(sessions),
    getSession: sessions.getSession.bind(sessions),
    updateSessionMetadata: sessions.updateSessionMetadata.bind(sessions),
    updateSessionPermissionMode: sessions.updateSessionPermissionMode.bind(sessions),
    deleteSession: sessions.deleteSession.bind(sessions),
    listSessions: sessions.listSessions.bind(sessions),

    // message
    addMessage: messages.addMessage.bind(messages),
    insertCompressionMessage: messages.insertCompressionMessage.bind(messages),
    listMessages: messages.listMessages.bind(messages),
    getMessageBySeq: messages.getMessageBySeq.bind(messages),
    getMessageById: messages.getMessageById.bind(messages),
    getFirstMessageAfterSeq: messages.getFirstMessageAfterSeq.bind(messages),
    listMessagesAfterSeq: messages.listMessagesAfterSeq.bind(messages),
    listMessagesBeforeOrAtSeq: messages.listMessagesBeforeOrAtSeq.bind(messages),
    getRecentMessages: messages.getRecentMessages.bind(messages),
    deleteMessagesAfter: messages.deleteMessagesAfter.bind(messages),
    updateMessage: messages.updateMessage.bind(messages),

    // run + run_steps
    createRun: runs.createRun.bind(runs),
    updateRunStatus: runs.updateRunStatus.bind(runs),
    getRun: runs.getRun.bind(runs),
    listRuns: runs.listRuns.bind(runs),
    addRunStep: runs.addRunStep.bind(runs),
    updateRunStepsMessageId: runs.updateRunStepsMessageId.bind(runs),
    listRunSteps: runs.listRunSteps.bind(runs),

    // child_agents
    createChildAgent: childAgents.createChildAgent.bind(childAgents),
    listChildAgents: childAgents.listChildAgents.bind(childAgents),
    getChildAgent: childAgents.getChildAgent.bind(childAgents),
    updateChildAgentLastRun: childAgents.updateChildAgentLastRun.bind(childAgents),

    /** 跨域：按 child agent 的 thread_key 取最近消息。 */
    getRecentMessagesByChildAgent: (sessionId: string, childAgentId: string, limit = DEFAULT_MESSAGE_LIST_LIMIT) => {
      const child = childAgents.getChildAgent(sessionId, childAgentId);
      if (!child) {
        return [];
      }
      return messages.getRecentMessages(sessionId, limit, child.thread_key);
    },

    // outbox
    getNextSessionSeq: outbox.getNextSessionSeq.bind(outbox),
    appendOutbox: outbox.appendOutbox.bind(outbox),
    fetchPendingOutbox: outbox.fetchPendingOutbox.bind(outbox),
    claimPendingOutbox: outbox.claimPendingOutbox.bind(outbox),
    listOutboxForReplay: outbox.listOutboxForReplay.bind(outbox),
    getOutboxRow: outbox.getOutboxRow.bind(outbox),
    listOutbox: outbox.listOutbox.bind(outbox),
    markOutboxDelivered: outbox.markOutboxDelivered.bind(outbox),
    markOutboxRetrying: outbox.markOutboxRetrying.bind(outbox),
    markOutboxFailed: outbox.markOutboxFailed.bind(outbox),
    retryOutbox: outbox.retryOutbox.bind(outbox),
    retryOutboxBatch: outbox.retryOutboxBatch.bind(outbox),
    deleteDeliveredOutbox: outbox.deleteDeliveredOutbox.bind(outbox),
    getOutboxStats: outbox.getOutboxStats.bind(outbox),

    // resource
    getPersistedExecutionOverview: resources.getPersistedExecutionOverview.bind(resources),
    registerResource: resources.registerResource.bind(resources),
    listResources: resources.listResources.bind(resources),
    attachResourceToStep: resources.attachResourceToStep.bind(resources),

    // metric(智能体性能监控:每次 agent run 的指标明细 + 按 agent 聚合)
    insertMetric: metrics.insertMetric.bind(metrics),
    aggregateMetrics: metrics.aggregateMetrics.bind(metrics),
    resetMetrics: metrics.resetMetrics.bind(metrics),
    aggregateTokenTrend: metrics.aggregateTokenTrend.bind(metrics),
    aggregateModelUsage: metrics.aggregateModelUsage.bind(metrics),
    aggregateActivityHeatmap: metrics.aggregateActivityHeatmap.bind(metrics),
    aggregateDailyActivity: metrics.aggregateDailyActivity.bind(metrics),

    // 跨域事务（组合 message/run/outbox ops）
    runInTransaction<T>(operation: (tx: ConversationStoreTransaction) => T): T {
      return runInTransaction(db, () => operation(createTransactionFacade()));
    },
  } satisfies ConversationStore;
}

/** 聚合类型转出（createConversationStore facade）；窄契约/DTO 见 contracts/conversation-store。 */
export type { ConversationStore } from "../../../contracts/conversation-store/index.js";
