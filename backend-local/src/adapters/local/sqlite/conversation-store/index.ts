import { createConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { SessionOps } from "./session-ops.js";
import { MessageOps, DEFAULT_MESSAGE_LIST_LIMIT } from "./message-ops.js";
import { RunOps } from "./run-ops.js";
import { ChildAgentOps } from "./child-agent-ops.js";
import { OutboxOps } from "./outbox-ops.js";
import { ResourceOps } from "./resource-ops.js";
import { MetricOps } from "./metric-ops.js";
import { PendingInteractionOps } from "./pending-interaction-ops.js";
import { ProviderContinuationOps } from "./provider-continuation-ops.js";
import { WorkflowTaskOps } from "./workflow-task-ops.js";
import { GoalOps } from "./goal-ops.js";
import { SessionListProjector } from "./session-list-projector.js";
import { WorkspaceOps } from "./workspace-ops.js";

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
  const workspaces = new WorkspaceOps(db);
  const runs = new RunOps(db);
  const childAgents = new ChildAgentOps(db);
  const outbox = new OutboxOps(db);
  const resources = new ResourceOps(db, dataRoot, sessions, workspaces);
  const metrics = new MetricOps(db);
  const pendingInteractions = new PendingInteractionOps(db);
  const providerContinuations = new ProviderContinuationOps(db);
  const workflowTasks = new WorkflowTaskOps(db);
  const goals = new GoalOps(db);

  const createTransactionFacade = () => ({
    createSession: sessions.createSessionInTransaction.bind(sessions),
    getSession: sessions.getSession.bind(sessions),
    updateSessionMetadata: sessions.updateSessionMetadataInTransaction.bind(sessions),
    addMessage: messages.addMessageInTransaction.bind(messages),
    getMessageById: messages.getMessageById.bind(messages),
    updateMessage: messages.updateMessageInTransaction.bind(messages),
    createRun: runs.createRun.bind(runs),
    getRun: runs.getRun.bind(runs),
    listRuns: runs.listRuns.bind(runs),
    getRunStepByEventId: runs.getRunStepByEventId.bind(runs),
    addRunStep: runs.addRunStepInTransaction.bind(runs),
    updateRunStepsMessageId: runs.updateRunStepsMessageId.bind(runs),
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
    renewPendingClaim: pendingInteractions.renewPendingClaim.bind(pendingInteractions),
    finalizePendingInteractions: pendingInteractions.finalizePendingInteractions.bind(pendingInteractions),
    nextSessionSeq: outbox.nextSessionSeqInTransaction.bind(outbox),
    appendOutbox: outbox.appendOutboxInTransaction.bind(outbox),
    // 纯读、不开新事务（listMessages 仅 SELECT），事务内读消除 TOCTOU，故直接 bind 无需 InTransaction 变体。
    getRecentMessages: messages.getRecentMessages.bind(messages),
    putProviderContinuation: providerContinuations.putProviderContinuationInTransaction.bind(providerContinuations),
    deleteProviderContinuations: providerContinuations.deleteProviderContinuations.bind(providerContinuations),
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
    listSessionFacets: sessions.listSessionFacets.bind(sessions),
    rebuildSessionListProjection: projector.rebuildSessionListProjection.bind(projector),

    // workspace
    resolveLocalWorkspace: workspaces.resolveLocal.bind(workspaces),
    getWorkspaceById: workspaces.getById.bind(workspaces),
    getWorkspaceByCanonicalKey: workspaces.getByCanonicalKey.bind(workspaces),
    listWorkspacesByIds: workspaces.listByIds.bind(workspaces),
    updateLocalWorkspacePath: workspaces.updateLocalPath.bind(workspaces),

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

    // private provider continuation state
    putProviderContinuation: providerContinuations.putProviderContinuation.bind(providerContinuations),
    getProviderContinuation: providerContinuations.getProviderContinuation.bind(providerContinuations),
    deleteProviderContinuations: providerContinuations.deleteProviderContinuations.bind(providerContinuations),

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


    // 跨域事务（组合 message/run/outbox ops）
    runInTransaction<T>(operation: (tx: ReturnType<typeof createTransactionFacade>) => T): T {
      return runInTransaction(db, () => operation(createTransactionFacade()));
    },
  };
}

export type ConversationStore = ReturnType<typeof createConversationStore>;
export type ConversationStoreTransaction = Parameters<Parameters<ConversationStore["runInTransaction"]>[0]>[0];
