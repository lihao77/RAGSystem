import { createConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { SessionOps } from "./session-ops.js";
import { MessageOps, DEFAULT_MESSAGE_LIST_LIMIT } from "./message-ops.js";
import { MessageRequestOps } from './message-request-ops.js';
import { RunOps } from "./run-ops.js";
import { ChildAgentOps } from "./child-agent-ops.js";
import { OutboxOps } from "./outbox-ops.js";
import { MetricOps } from "./metric-ops.js";
import { PendingInteractionOps } from "./pending-interaction-ops.js";
import { WorkflowTaskOps } from "./workflow-task-ops.js";
import { GoalOps } from "./goal-ops.js";
import { MessageFeedbackOps } from "./feedback-ops.js";
import { SessionListProjector } from "./session-list-projector.js";
import type { FirstVisibleUserMessageNotifier } from "./message-ops.js";
import { WorkspaceOps } from "./workspace-ops.js";
import { AgentMailboxOps } from "./agent-mailbox-ops.js";

export interface ConversationStoreOptions {
  dbPath: string;
  dataRoot?: string | undefined;
}

/**
 * 组装会话存储（无主类）：创建共享 SQLite 句柄 + 6 个聚合根 ops，组合为统一 facade。
 * 类比 tools 的 createXxxTools(deps) / agent 的 createAgentExecutionService(params) 工厂。
 * ops 方法通过 bind 绑定 this；跨域方法（getRecentMessagesByChildAgent / 事务 facade）显式协调。
 * The facade type is inferred from this factory; Local SQLite does not publish
 * a second hand-written storage contract.
 */
export function createConversationStore(options: ConversationStoreOptions) {
  const { db, dataRoot } = createConversationDb({ dbPath: options.dbPath, dataRoot: options.dataRoot });
  const projector = new SessionListProjector(db);
  const sessions = new SessionOps(db, projector);
  const messages = new MessageOps(db, projector);
  const messageRequests = new MessageRequestOps(db);
  const workspaces = new WorkspaceOps(db);
  const runs = new RunOps(db);
  const childAgents = new ChildAgentOps(db);
  const outbox = new OutboxOps(db);
  const metrics = new MetricOps(db);
  const pendingInteractions = new PendingInteractionOps(db);
  const workflowTasks = new WorkflowTaskOps(db);
  const goals = new GoalOps(db);
  const agentMailbox = new AgentMailboxOps(db);
  const messageFeedback = new MessageFeedbackOps(db);

  const createTransactionFacade = () => ({
    createSession: sessions.createSessionInTransaction.bind(sessions),
    getSession: sessions.getSession.bind(sessions),
    getSessionStateFacts: sessions.getSessionStateFacts.bind(sessions),
    updateSessionMetadata: sessions.updateSessionMetadataInTransaction.bind(sessions),
    addMessage: messages.addMessageInTransaction.bind(messages),
    getMessageById: messages.getMessageById.bind(messages),
    listMessages: messages.listMessages.bind(messages),
    listVisibleMessages: messages.listVisibleMessages.bind(messages),
    updateMessage: messages.updateMessageInTransaction.bind(messages),
    createRun: runs.createRun.bind(runs),
    getRun: runs.getRun.bind(runs),
    listRuns: runs.listRuns.bind(runs),
    listParticipantRuns: runs.listParticipantRuns.bind(runs),
    listActiveRootRuns: runs.listActiveRootRuns.bind(runs),
    getLatestThreadRun: runs.getLatestThreadRun.bind(runs),
    getLatestTerminalRootRun: runs.getLatestTerminalRootRun.bind(runs),
    updateRunStatus: runs.updateRunStatus.bind(runs),
    suspendPendingInteractions: pendingInteractions.suspendPendingInteractions.bind(pendingInteractions),
    createPendingInteraction: pendingInteractions.createPendingInteraction.bind(pendingInteractions),
    getPendingInteraction: pendingInteractions.getPendingInteraction.bind(pendingInteractions),
    listPendingInteractions: pendingInteractions.listPendingInteractions.bind(pendingInteractions),
    updatePendingInteractionStatus: pendingInteractions.updatePendingInteractionStatus.bind(pendingInteractions),
    markPendingBatchResuming: pendingInteractions.markPendingBatchResuming.bind(pendingInteractions),
    releasePendingBatch: pendingInteractions.releasePendingBatch.bind(pendingInteractions),
    claimPendingBatch: pendingInteractions.claimPendingBatch.bind(pendingInteractions),
    releasePendingClaim: pendingInteractions.releasePendingClaim.bind(pendingInteractions),
    finalizePendingInteractions: pendingInteractions.finalizePendingInteractions.bind(pendingInteractions),
    nextSessionSeq: outbox.nextSessionSeqInTransaction.bind(outbox),
    appendOutbox: outbox.appendOutboxInTransaction.bind(outbox),
    getSessionOutboxWatermark: outbox.getSessionOutboxWatermark.bind(outbox),
    getOutboxRowByEventId: outbox.loadOutboxRowByEventId.bind(outbox),
    // 纯读、不开新事务（listMessages 仅 SELECT），事务内读消除 TOCTOU，故直接 bind 无需 InTransaction 变体。
    getRecentMessages: messages.getRecentMessages.bind(messages),
    enqueueAgentMailboxMessage: agentMailbox.enqueueInTransaction.bind(agentMailbox),
    ackAgentMailboxMessage: agentMailbox.ackInTransaction.bind(agentMailbox),
    getAgentMailboxMessage: agentMailbox.getInTransaction.bind(agentMailbox),
    updateChildAgentLastRun: childAgents.updateChildAgentLastRun.bind(childAgents),
    settleAgentMailboxMessage: agentMailbox.settleInTransaction.bind(agentMailbox),
    getCurrentGoal: goals.getCurrent.bind(goals),
  });

  return {
    close: () => db.close(),
    beginMessageRequest: messageRequests.beginMessageRequest.bind(messageRequests),
    renewMessageRequest: messageRequests.renewMessageRequest.bind(messageRequests),
    settleMessageRequest: messageRequests.settleMessageRequest.bind(messageRequests),
    listMessageRequestStatuses: messageRequests.listMessageRequestStatuses.bind(messageRequests),
    cancelQueuedMessageRequest: messageRequests.cancelQueuedMessageRequest.bind(messageRequests),
    agentMailbox,

    // session
    createSession: sessions.createSession.bind(sessions),
    getSession: sessions.getSession.bind(sessions),
    updateSessionMetadata: sessions.updateSessionMetadata.bind(sessions),
    anchorSessionTeamSnapshot: sessions.anchorSessionTeamSnapshot.bind(sessions),
    updateSessionPermissionMode: sessions.updateSessionPermissionMode.bind(sessions),
    deleteSession: sessions.deleteSession.bind(sessions),
    listSessions: sessions.listSessions.bind(sessions),
    listSessionFacets: sessions.listSessionFacets.bind(sessions),
    getSessionListProjection: sessions.getSessionListProjection.bind(sessions),
    getSessionStateFacts: sessions.getSessionStateFacts.bind(sessions),
    rebuildSessionListProjection: projector.rebuildSessionListProjection.bind(projector),
    /** LLM 生成标题回写（override 优先，带可见用户消息存在性守卫）。 */
    updateSessionListTitle: projector.updateTitle.bind(projector),
    /** 组合根装配标题生成服务后注册；消息落库路径据此在首条可见用户消息确立时收到通知。 */
    setFirstVisibleUserMessageNotifier: (notifier: FirstVisibleUserMessageNotifier | null) => {
      messages.setFirstVisibleUserMessageNotifier(notifier);
    },

    // workspace
    resolveLocalWorkspace: workspaces.resolveLocal.bind(workspaces),
    getWorkspaceById: workspaces.getById.bind(workspaces),
    getWorkspaceByCanonicalKey: workspaces.getByCanonicalKey.bind(workspaces),
    listWorkspacesByIds: workspaces.listByIds.bind(workspaces),
    listAllWorkspaces: workspaces.listAll.bind(workspaces),
    removeWorkspace: workspaces.remove.bind(workspaces),
    renameWorkspace: workspaces.rename.bind(workspaces),
    updateLocalWorkspacePath: workspaces.updateLocalPath.bind(workspaces),

    // message
    addMessage: messages.addMessage.bind(messages),
    insertCompressionMessage: messages.insertCompressionMessage.bind(messages),
    listMessages: messages.listMessages.bind(messages),
    listVisibleMessages: messages.listVisibleMessages.bind(messages),
    getMessageBySeq: messages.getMessageBySeq.bind(messages),
    getMessageById: messages.getMessageById.bind(messages),
    getFirstMessageAfterSeq: messages.getFirstMessageAfterSeq.bind(messages),
    listMessagesAfterSeq: messages.listMessagesAfterSeq.bind(messages),
    listMessagesBeforeOrAtSeq: messages.listMessagesBeforeOrAtSeq.bind(messages),
    getRecentMessages: messages.getRecentMessages.bind(messages),
    getMaxSeq: messages.getMaxSeq.bind(messages),
    deleteMessagesAfter: messages.deleteMessagesAfter.bind(messages),
    updateMessage: messages.updateMessage.bind(messages),

    // run
    createRun: runs.createRun.bind(runs),
    updateRunStatus: runs.updateRunStatus.bind(runs),
    getRun: runs.getRun.bind(runs),
    listRuns: runs.listRuns.bind(runs),
    listParticipantRuns: runs.listParticipantRuns.bind(runs),
    listActiveRootRuns: runs.listActiveRootRuns.bind(runs),
    getLatestThreadRun: runs.getLatestThreadRun.bind(runs),
    getLatestTerminalRootRun: runs.getLatestTerminalRootRun.bind(runs),

    // child_agents
    createChildAgent: childAgents.createChildAgent.bind(childAgents),
    listChildAgents: childAgents.listChildAgents.bind(childAgents),
    getChildAgent: childAgents.getChildAgent.bind(childAgents),
    findChildAgentByCreator: childAgents.findChildAgentByCreator.bind(childAgents),
    updateChildAgentLastRun: childAgents.updateChildAgentLastRun.bind(childAgents),

    // durable workflow tasks
    createWorkflowTask: workflowTasks.create.bind(workflowTasks),
    getWorkflowTask: workflowTasks.get.bind(workflowTasks),
    updateWorkflowTask: workflowTasks.update.bind(workflowTasks),
    deleteWorkflowTask: workflowTasks.delete.bind(workflowTasks),
    listWorkflowTasks: workflowTasks.list.bind(workflowTasks),

    // durable session Goals
    createGoal: goals.create.bind(goals),
    getGoal: goals.get.bind(goals),
    getCurrentGoal: goals.getCurrent.bind(goals),
    updateGoal: goals.update.bind(goals),
    listGoals: goals.list.bind(goals),
    claimGoalContinuation: goals.claimContinuation.bind(goals),
    releaseGoalContinuation: goals.releaseContinuation.bind(goals),
    setContinuationReason: goals.setContinuationReason.bind(goals),
    restartBlocked: goals.restartBlocked.bind(goals),

    // message feedback（消息级赞/踩）
    setMessageFeedback: messageFeedback.set.bind(messageFeedback),
    clearMessageFeedback: messageFeedback.clear.bind(messageFeedback),
    listMessageFeedback: messageFeedback.list.bind(messageFeedback),
    listNegativeMessageFeedback: messageFeedback.listNegative.bind(messageFeedback),

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
    getSessionOutboxWatermark: outbox.getSessionOutboxWatermark.bind(outbox),
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
    getPersistedExecutionOverview: runs.getPersistedExecutionOverview.bind(runs),

    // metric(智能体性能监控:每次 agent run 的指标明细 + 按 agent 聚合)
    insertMetric: metrics.insertMetric.bind(metrics),
    aggregateMetrics: metrics.aggregateMetrics.bind(metrics),
    resetMetrics: metrics.resetMetrics.bind(metrics),
    aggregateTokenTrend: metrics.aggregateTokenTrend.bind(metrics),
    aggregateModelUsage: metrics.aggregateModelUsage.bind(metrics),
    aggregateActivityHeatmap: metrics.aggregateActivityHeatmap.bind(metrics),
    aggregateDailyActivity: metrics.aggregateDailyActivity.bind(metrics),

    // durable pending interactions
    createPendingInteraction: pendingInteractions.createPendingInteraction.bind(pendingInteractions),
    getPendingInteraction: pendingInteractions.getPendingInteraction.bind(pendingInteractions),
    listPendingInteractions: pendingInteractions.listPendingInteractions.bind(pendingInteractions),
    updatePendingInteractionStatus: pendingInteractions.updatePendingInteractionStatus.bind(pendingInteractions),
    markPendingBatchResuming: pendingInteractions.markPendingBatchResuming.bind(pendingInteractions),
    releasePendingBatch: pendingInteractions.releasePendingBatch.bind(pendingInteractions),
    finalizePendingInteractions: pendingInteractions.finalizePendingInteractions.bind(pendingInteractions),
    suspendPendingInteractions: pendingInteractions.suspendPendingInteractions.bind(pendingInteractions),
    consumePendingResolution: pendingInteractions.consumePendingResolution.bind(pendingInteractions),
    cancelPendingInteractions: pendingInteractions.cancelPendingInteractions.bind(pendingInteractions),

    // durable Agent mailbox
    enqueueAgentMailboxMessage: agentMailbox.enqueue.bind(agentMailbox),
    getAgentMailboxMessage: agentMailbox.get.bind(agentMailbox),
    claimAgentMailboxMessages: agentMailbox.claim.bind(agentMailbox),
    ackAgentMailboxMessage: agentMailbox.ack.bind(agentMailbox),
    releaseAgentMailboxMessage: agentMailbox.release.bind(agentMailbox),
    expireAgentMailboxMessages: agentMailbox.expire.bind(agentMailbox),


    // 跨域事务（组合 message/run/outbox ops）
    runInTransaction<T>(operation: (tx: ReturnType<typeof createTransactionFacade>) => T): T {
      return runInTransaction(db, () => operation(createTransactionFacade()));
    },
  };
}

export type ConversationStore = ReturnType<typeof createConversationStore>;
export type ConversationStoreTransaction = Parameters<Parameters<ConversationStore["runInTransaction"]>[0]>[0];
