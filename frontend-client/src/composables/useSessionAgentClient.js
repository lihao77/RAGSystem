import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { useRunRuntime } from './useRunRuntime.js';
import { createSessionTransport } from './sessionTransport.js';
import { createSessionInteractionController } from './sessionInteractionController.js';
import { createSessionRunRecovery } from './sessionRunRecovery.js';
import { createSessionCommandController } from './sessionCommandController.js';
import { createSessionTaskState } from './sessionTaskState.js';
import { createSessionEnvelopeDispatcher } from './sessionEnvelopeDispatcher.js';

export { resetActiveRunForSend, serializeAttachmentForSend } from './sessionCommandController.js';

/**
 * 会话 AgentClient（对标 packages/agent-widget/src/adapter/widget-agent-client.ts 的 WidgetAgentClient）。
 *
 * 组合 transport、事件分发、运行态、send/stop、交互提交与 task 状态上下文，
 * 保持单向数据流（WS → handleEnvelope → store/投影）和稳定的 facade 接口。
 * 状态读 session-run store 单源（替代 widget 的 Observable——Vue 场景下 store 已是推模式）。
 *
 * 组成：
 * - WS transport：连接/重连/cursor 去重/delegate 拦截/commandFallback/resumeRecovery 定时器（2.5a）
 * - SessionEnvelopeDispatcher：顶层事件编排，写 store + 调投影（2.5b）
 * - useRunRuntime 组合子：phase/timing/seq gap/durable replay/finalize（client 单向组合）
 * - send/stop：HTTP 降级/followup/附件/task 预查（2.5c）
 * - respondInteraction：统一 approval/user_input WS 提交 + ack + HTTP 降级（2.5d）
 * - SessionTaskState：task 状态合并、刷新、乐观启动与局部更新（2.5e）
 *
 * @param {Object} deps 业务回调（投影/UI/消息缓存/会话切换/send 单向依赖）
 */
export function useSessionAgentClient(deps) {
  const sessionRunStore = useSessionRunStore();
  const {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    contextUsage,
    sessionTaskInfo,
    sessionExecutionObservability,
    llmRetryState,
  } = storeToRefs(sessionRunStore);
  const activeRun = sessionRunStore.activeRun;
  const {
    enqueueFollowupCandidate,
    takeFollowupCandidate,
    markFollowupCandidateFailed,
    bindUnassignedFollowupCandidates,
  } = sessionRunStore;

  const taskState = createSessionTaskState({
    currentSessionId,
    sessionTaskInfo,
    sessionExecutionObservability,
  });
  const {
    mergeExecutionObservability,
    refreshSessionExecutionState,
    beginOptimisticExecutionState,
  } = taskState;

  // run 运行态机（phase/timing/seq gap/durable replay/finalize），状态读 store 单源；
  // 注入 client 内建 refreshSessionExecutionState（第二参数，避免 spread deps 触发 getter TDZ），
  // 使 finalize/durable terminal 的 task 状态同步走 client 单源。
  const runtime = useRunRuntime(deps, { refreshSessionExecutionState });

  const recovery = createSessionRunRecovery({
    getCurrentSessionId: () => currentSessionId.value,
    activeRun,
    messages,
    isLoading,
    deleteMessageCache: deps.deleteMessageCache,
    loadSessionMessages: deps.loadSessionMessages,
    refreshSessionExecutionState,
  });
  const invalidateActiveStream = recovery.invalidateActiveStream;
  const scheduleCommandFallback = recovery.scheduleCommandFallback;
  const clearCommandFallback = recovery.clearCommandFallback;
  const scheduleSessionResumeRecovery = recovery.scheduleSessionResumeRecovery;
  const clearSessionResumeRecovery = recovery.clearSessionResumeRecovery;

  let envelopeDispatcher;
  const transport = createSessionTransport({
    getCurrentSessionId: () => currentSessionId.value,
    issueTicket: deps.issueSessionWsTicket,
    onEnvelope: (event, sessionId) => envelopeDispatcher.handleEnvelope(event, sessionId),
    onDisconnect: () => {
      clearCommandFallback();
      clearSessionResumeRecovery();
      deps.resetApprovalState();
    },
    onSocketClose: clearCommandFallback,
    onReconnectExhausted: (sessionId) => {
      if (activeRun.active) finalizeActiveRun(sessionId);
    },
  });
  const connectSessionWS = transport.connect;
  const disconnectSessionWS = transport.disconnect;
  const getWS = transport.getSocket;
  const getLastEventSeq = transport.getLastEventSeq;
  const resetSessionEventCursor = transport.resetSessionEventCursor;
  const interactionController = createSessionInteractionController({
    getCurrentSessionId: () => currentSessionId.value,
    getSocket: () => deps.getWS?.() || getWS(),
  });
  const finalizeActiveRun = runtime.finalizeActiveRun;

  const commandController = createSessionCommandController({
    deps,
    currentSessionId,
    messages,
    isLoading,
    contextUsage,
    sessionTaskInfo,
    activeRun,
    getSocket: () => deps.getWS?.() || getWS(),
    mergeExecutionObservability,
    beginOptimisticExecutionState,
    scheduleCommandFallback,
    enqueueFollowupCandidate,
    markFollowupCandidateFailed,
  });
  const send = commandController.send;
  const stop = commandController.stop;

  envelopeDispatcher = createSessionEnvelopeDispatcher({
    deps,
    state: {
      currentSessionId,
      messages,
      isLoading,
      isCompressing,
      contextUsage,
      llmRetryState,
      activeRun,
    },
    runtime,
    recovery,
    interaction: interactionController,
    taskState,
    getStop: () => stop,
    takeFollowupCandidate,
    bindUnassignedFollowupCandidates,
  });
  const { handleEnvelope, handleRunEvent, resetStreamSessionState } = envelopeDispatcher;

  return {
    invalidateActiveStream,
    scheduleCommandFallback,
    clearCommandFallback,
    clearSessionResumeRecovery,
    scheduleSessionResumeRecovery,
    connectSessionWS,
    disconnectSessionWS,
    getWS,
    getLastEventSeq,
    resetSessionEventCursor,
    handleEnvelope,
    handleRunEvent,
    finalizeActiveRun,
    resetStreamSessionState,
    send,
    stop,
    respondInteraction: interactionController.respond,
    mergeExecutionObservability,
    refreshSessionExecutionState,
    beginOptimisticExecutionState,
  };
}
