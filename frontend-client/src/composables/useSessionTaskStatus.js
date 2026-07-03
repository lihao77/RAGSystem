import { storeToRefs } from 'pinia';
import { resetActiveRunState } from '../stores/session-run.js';
import { getContextSnapshot, getSessionTaskStatus } from '../api/session.js';
import { useSessionRunStore } from '../stores/session-run.js';

/**
 * 会话任务状态、可观测性管理。
 *
 * sessionTaskInfo / sessionExecutionObservability / contextUsage / currentSessionId /
 * messages / isLoading 取自 useSessionRunStore 单源；本 composable 只承载行为（拉取/合并/清理），
 * 不持有状态。
 *
 * @param {Object} deps
 * @param {Function} deps.shouldRefreshFn - shouldRefreshSessionMessagesAfterResume
 * @param {Function} deps.shouldRunWatchdogFn - shouldRunResumeRecoveryWatchdog
 * @param {Function} deps.invalidateActiveStream
 * @param {Function} deps.loadSessionMessages
 * @param {Function} deps.createAssistantMessage
 * @param {Function} deps.scheduleCommandFallback
 * @param {Function} deps.scheduleResumeRecovery
 * @param {Function} deps.clearLlmRetryState
 */
export function useSessionTaskStatus(deps) {
  const sessionRunStore = useSessionRunStore();
  const {
    sessionTaskInfo,
    sessionExecutionObservability,
    contextUsage,
    currentSessionId,
    messages,
    isLoading,
  } = storeToRefs(sessionRunStore);
  const activeRun = sessionRunStore.activeRun;

  const buildObservabilityFromTaskInfo = (taskInfo) => {
    if (!taskInfo) return null;
    return {
      task_id: taskInfo.task_id,
      session_id: taskInfo.session_id,
      run_id: taskInfo.run_id,
      execution_kind: taskInfo.execution_kind,
      request_id: taskInfo.request_id,
    };
  };

  const mergeExecutionObservability = (payload = {}) => {
    const current = sessionExecutionObservability.value || {};
    sessionExecutionObservability.value = {
      task_id: payload.task_id ?? current.task_id ?? null,
      session_id: payload.session_id ?? current.session_id ?? currentSessionId.value ?? null,
      run_id: payload.run_id ?? current.run_id ?? null,
      execution_kind: payload.execution_kind ?? current.execution_kind ?? null,
      request_id: payload.request_id ?? current.request_id ?? null,
    };
  };

  const loadContextSnapshot = async (sessionId) => {
    if (!sessionId) return;
    try {
      const json = await getContextSnapshot(sessionId);
      const tokenStats = json.data?.token_stats;
      if (
        tokenStats &&
        typeof tokenStats.total_tokens === 'number' &&
        typeof tokenStats.budget_tokens === 'number'
      ) {
        contextUsage.value = {
          used: tokenStats.total_tokens,
          max: tokenStats.budget_tokens,
        };
      }
    } catch (error) {
      console.warn('loadContextSnapshot 失败:', error.message);
    }
  };

  const refreshSessionExecutionState = async (sessionId) => {
    if (!sessionId) return;
    try {
      const result = await getSessionTaskStatus(sessionId);
      if (currentSessionId.value !== sessionId) return;
      if (result.data?.task_info) {
        sessionTaskInfo.value = result.data.task_info;
      }
      if (result.data?.observability) {
        mergeExecutionObservability(result.data.observability);
      }
    } catch (error) {
      console.warn('refreshSessionExecutionState 状态同步失败:', error.message);
    }
  };

  /** 检查会话是否有正在执行的任务，若有则恢复 loading 状态 */
  const checkSessionTaskStatus = async (sessionId) => {
    if (!sessionId) return;
    try {
      const result = await getSessionTaskStatus(sessionId);
      if (currentSessionId.value !== sessionId) return;
      const hasRunningTask = Boolean(result.data?.has_running_task);
      const hasActiveSystemCommand = Boolean(result.data?.has_active_system_command);
      const needsMessageRefresh = !hasRunningTask && deps.shouldRefreshFn({
        hasRunningTask,
        activeRun: activeRun.active,
        messages: messages.value,
      });
      if (result.data?.task_info) {
        sessionTaskInfo.value = result.data.task_info;
      }
      if (result.data?.observability) {
        mergeExecutionObservability(result.data.observability);
      } else if (result.data?.task_info) {
        mergeExecutionObservability(buildObservabilityFromTaskInfo(result.data.task_info));
      }
      if (deps.shouldRunWatchdogFn({ hasRunningTask, hasActiveSystemCommand })) {
        deps.scheduleResumeRecovery(sessionId);
      }
      if (!hasRunningTask && !hasActiveSystemCommand) {
        resetActiveRunState(activeRun);
        isLoading.value = false;
        if (needsMessageRefresh) {
          deps.invalidateActiveStream();
          deps.deleteMessageCache(sessionId);
          await deps.loadSessionMessages(sessionId, { silent: true });
        }
      }
      if (hasActiveSystemCommand && !isLoading.value) {
        isLoading.value = true;
        const lastMsg = messages.value[messages.value.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.finished) {
          messages.value.push(deps.createAssistantMessage());
        }
        activeRun.active = true;
        activeRun.assistantMsgIndex = messages.value.length - 1;
        deps.scheduleCommandFallback(sessionId, activeRun.assistantMsgIndex, 120000);
      }
    } catch (error) {
      console.warn('checkSessionTaskStatus 查询失败:', error.message);
    }
  };

  const clearExecutionState = ({ resetContextUsage = false } = {}) => {
    deps.clearLlmRetryState();
    sessionTaskInfo.value = null;
    sessionExecutionObservability.value = null;
    // contextUsage 是纯数据快照，切换会话时保留旧值，由 loadContextSnapshot 自然覆盖；
    // 仅在进入空白会话（无后续快照会到达）时显式重置，避免残留。
    if (resetContextUsage) contextUsage.value = { used: 0, max: 0 };
  };

  const beginOptimisticExecutionState = (sessionId) => {
    sessionTaskInfo.value = {
      ...(sessionTaskInfo.value || {}),
      task_id: null,
      session_id: sessionId,
      run_id: null,
      execution_kind: 'agent_stream',
      request_id: null,
      elapsed_seconds: null,
      started_at: null,
      finished_at: null,
      thread_alive: true,
      status: 'running',
    };
    mergeExecutionObservability({
      task_id: null,
      session_id: sessionId,
      run_id: null,
      execution_kind: 'agent_stream',
      request_id: null,
    });
  };

  return {
    buildObservabilityFromTaskInfo,
    mergeExecutionObservability,
    loadContextSnapshot,
    refreshSessionExecutionState,
    checkSessionTaskStatus,
    clearExecutionState,
    beginOptimisticExecutionState,
  };
}
