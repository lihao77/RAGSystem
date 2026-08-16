import { getCurrentInstance, onUnmounted } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { useRunRuntime } from './useRunRuntime.js';
import { createSessionInteractionController } from './sessionInteractionController.js';
import { createSessionRunRecovery } from './sessionRunRecovery.js';
import { createSessionCommandController } from './sessionCommandController.js';
import { createSessionEnvelopeDispatcher } from './sessionEnvelopeDispatcher.js';

export { createRequestId, serializeAttachmentForSend } from './sessionCommandController.js';

/**
 * 会话 AgentClient（对标 packages/agent-widget/src/adapter/widget-agent-client.ts 的 WidgetAgentClient）。
 *
 * 组合 chat-sdk、事件分发、运行态、send/stop、交互提交与 Session runtime 快照，
 * 保持单向数据流（SDK event → handleEnvelope → store/投影）和稳定的 facade 接口。
 * 状态读 session-run store 单源（替代 widget 的 Observable——Vue 场景下 store 已是推模式）。
 *
 * 组成：
 * - chat-sdk：WS 连接/重连、AG-UI fallback、ACK 与宿主工具委托（2.5a）
 * - SessionEnvelopeDispatcher：顶层事件编排，写 store + 调投影（2.5b）
 * - useRunRuntime 组合子：phase/timing/seq gap/durable replay/finalize（client 单向组合）
 * - send/stop：followup/附件/allowed_actions 校验后交给 SDK（2.5c）
 * - respondInteraction：统一 approval/user_input 校验后交给 SDK（2.5d）
 * - session.runtime：后端权威状态、初次加载策略与可执行动作（2.5e）
 *
 * @param {Object} deps 业务回调（投影/UI/消息缓存/会话切换/send 单向依赖）
 */
export function useSessionAgentClient(deps) {
  const sessionRunStore = useSessionRunStore();
  const {
    currentSessionId,
    rootMessages: messages,
    isLoading,
    isCompressing,
    contextUsage,
    sessionRuntime,
    llmRetryState,
  } = storeToRefs(sessionRunStore);
  const activeRun = sessionRunStore.activeRun;
  const {
    applySessionRuntime,
    clearSessionRuntime,
    beginPendingCommand,
    finishPendingCommand,
    allowsRuntimeAction,
    reorderParticipantMessages,
  } = sessionRunStore;

  // run 运行态机只负责 phase/timing/seq gap/durable replay/finalize 展示投影；
  // Session 生命周期始终由 session.runtime 快照覆盖。
  const runtime = useRunRuntime(deps);

  const recovery = createSessionRunRecovery({
    activeRun,
    isLoading,
    deleteMessageCache: deps.deleteMessageCache,
    loadSessionMessages: deps.loadSessionMessages,
    finishPendingCommand,
  });
  const invalidateActiveStream = recovery.invalidateActiveStream;
  const scheduleCommandFallback = recovery.scheduleCommandFallback;
  const clearCommandFallback = recovery.clearCommandFallback;

  const finalizeActiveRun = runtime.finalizeActiveRun;
  let envelopeDispatcher;
  const sdk = deps.chatSdkClient;
  if (!sdk) throw new Error('Chat SDK 未初始化');
  const sdkEventCursors = new Map();
  const handleDisconnect = () => {
    clearCommandFallback();
    envelopeDispatcher?.resetInteractionPresentation();
    deps.resetApprovalState();
  };

  const sdkUnsubscribers = [];
  sdkUnsubscribers.push(sdk.on('event', (event) => {
    const sessionId = event.session_id || sdk.sessionId || currentSessionId.value;
    const heartbeatSeq = event.type === 'heartbeat' ? event.payload?.last_seq : null;
    const observedSeq = typeof event.seq === 'number' ? event.seq : heartbeatSeq;
    if (sessionId && typeof observedSeq === 'number') {
      sdkEventCursors.set(sessionId, Math.max(sdkEventCursors.get(sessionId) || 0, observedSeq));
    }
    if (sessionId) envelopeDispatcher?.handleEnvelope(event, sessionId);
  }));
  sdkUnsubscribers.push(sdk.on('status', (status) => {
    if (status.state === 'reconnecting') clearCommandFallback();
    if (status.state === 'disconnected') {
      handleDisconnect();
      if (status.reason === 'max retries exceeded' && currentSessionId.value && activeRun.active) {
        finalizeActiveRun(currentSessionId.value);
      }
    }
  }));

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    for (const unsubscribe of sdkUnsubscribers.splice(0)) unsubscribe?.();
    clearCommandFallback();
    envelopeDispatcher?.resetInteractionPresentation();
  };
  // ChatView is recreated when leaving/re-entering the page while the shared
  // SDK remains alive. Remove this view's listeners or every remount would
  // project each envelope multiple times.
  if (getCurrentInstance()) onUnmounted(dispose);

  const connectSessionWS = async (sessionId, options = {}) => {
    if (
      !options.historySnapshot
      && sdk.sessionId === sessionId
      && sdk.isConnected === true
    ) {
      return;
    }
    const afterEventSeq = sdkEventCursors.get(sessionId);
    await sdk.connect(sessionId, {
      ...(afterEventSeq !== undefined ? { afterEventSeq } : {}),
      ...(options.historySnapshot ? { historySnapshot: true } : {}),
    });
  };
  const reconnectSessionWS = async (sessionId, options = {}) => {
    sdk.disconnect();
    const afterEventSeq = sdkEventCursors.get(sessionId);
    await sdk.connect(sessionId, {
      ...(afterEventSeq !== undefined ? { afterEventSeq } : {}),
      ...(options.historySnapshot ? { historySnapshot: true } : {}),
    });
  };
  const disconnectSessionWS = () => sdk.disconnect();
  const getLastEventSeq = (sessionId = currentSessionId.value) => sdkEventCursors.get(sessionId) || 0;
  const initializeSessionEventCursor = (sessionId, afterEventSeq) => {
    if (sessionId === currentSessionId.value) {
      sdkEventCursors.set(sessionId, afterEventSeq);
    }
  };
  const interactionController = createSessionInteractionController({
    getSessionRuntime: () => sessionRuntime.value,
    respondViaSdk: (interactionId, response) => sdk.respondInteraction(interactionId, response.kind === 'user_input'
      ? { kind: 'user_input', value: String(response.value ?? '') }
      : response),
  });

  const commandController = createSessionCommandController({
    deps,
    currentSessionId,
    isLoading,
    allowsRuntimeAction,
    getSessionRuntime: () => sessionRuntime.value,
    beginPendingCommand,
    finishPendingCommand,
    scheduleCommandFallback,
    sendViaSdk: (input, requestId) => sdk.send({
      task: input.task,
      requestId,
      ...(input.selectedLlm ? { selectedLlm: input.selectedLlm } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.attachments ? { attachments: input.attachments } : {}),
    }),
    stopViaSdk: async () => { sdk.stop(); },
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
    applySessionRuntime,
    finishPendingCommand,
    reorderMessages: () => reorderParticipantMessages('root'),
    onRuntimeSnapshot: resolveRuntimeWaiters,
    getStop: () => stop,
  });
  const { handleEnvelope, handleRunEvent, resetStreamSessionState } = envelopeDispatcher;

  /** @type {Map<string, Set<(snapshot: any) => void>>} */
  const runtimeWaiters = new Map();
  function resolveRuntimeWaiters(sessionId, snapshot) {
    const waiters = runtimeWaiters.get(sessionId);
    if (!waiters) return;
    runtimeWaiters.delete(sessionId);
    for (const resolve of waiters) resolve(snapshot);
  }
  const waitForSessionRuntime = (sessionId, timeoutMs = 10000) => {
    if (currentSessionId.value === sessionId && sessionRuntime.value) return Promise.resolve(sessionRuntime.value);
    return new Promise((resolve, reject) => {
      const waiters = runtimeWaiters.get(sessionId) || new Set();
      let wrappedResolve;
      const timer = setTimeout(() => {
        waiters.delete(wrappedResolve);
        if (waiters.size === 0) runtimeWaiters.delete(sessionId);
        reject(new Error('等待 Session runtime 快照超时'));
      }, timeoutMs);
      wrappedResolve = (snapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      };
      waiters.add(wrappedResolve);
      runtimeWaiters.set(sessionId, waiters);
    });
  };
  let resumePromise = null;
  const resume = async () => {
    const sessionId = currentSessionId.value;
    const interactionId = sessionRuntime.value?.resume_interaction_id;
    if (!sessionId || !interactionId || !allowsRuntimeAction('resume_run')) return false;
    if (resumePromise) return resumePromise;
    resumePromise = sdk.resume()
      .catch((error) => {
        deps.showToast?.(error instanceof Error ? error.message : '恢复执行失败', 'warning');
        return false;
      })
      .finally(() => { resumePromise = null; });
    return resumePromise;
  };

  return {
    invalidateActiveStream,
    scheduleCommandFallback,
    clearCommandFallback,
    connectSessionWS,
    reconnectSessionWS,
    disconnectSessionWS,
    getLastEventSeq,
    initializeSessionEventCursor,
    handleEnvelope,
    handleRunEvent,
    finalizeActiveRun,
    resetStreamSessionState,
    dispose,
    send,
    stop,
    respondInteraction: interactionController.respond,
    resume,
    waitForSessionRuntime,
    clearSessionRuntime,
  };
}
