import { ref } from 'vue';

/**
 * 会话任务状态、可观测性管理。
 *
 * @param {Object} deps
 * @param {import('vue').Ref} deps.currentSessionId
 * @param {import('vue').Ref} deps.messages
 * @param {import('vue').Ref} deps.isLoading
 * @param {Function} deps.shouldRefreshFn - shouldRefreshSessionMessagesAfterResume
 * @param {Function} deps.shouldRunWatchdogFn - shouldRunResumeRecoveryWatchdog
 * @param {Function} deps.getActiveRun - () => activeRun reactive
 * @param {Function} deps.invalidateActiveStream
 * @param {Function} deps.loadSessionMessages
 * @param {Function} deps.createAssistantMessage
 * @param {Function} deps.scheduleCommandFallback
 * @param {Function} deps.scheduleResumeRecovery
 * @param {Function} deps.clearLlmRetryState
 */
export function useSessionTaskStatus(deps) {
  const sessionTaskInfo = ref(null);
  const sessionExecutionObservability = ref(null);
  const contextUsage = ref({ used: 0, max: 0 });

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
      session_id: payload.session_id ?? current.session_id ?? deps.currentSessionId.value ?? null,
      run_id: payload.run_id ?? current.run_id ?? null,
      execution_kind: payload.execution_kind ?? current.execution_kind ?? null,
      request_id: payload.request_id ?? current.request_id ?? null,
    };
  };

  const loadContextSnapshot = async (sessionId) => {
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/agent/context-snapshot?session_id=${encodeURIComponent(sessionId)}`);
      if (!res.ok) return;
      const json = await res.json();
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
    } catch (_) {}
  };

  const refreshSessionExecutionState = async (sessionId) => {
    if (!sessionId) return;
    try {
      const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`);
      if (!resp.ok) return;
      const result = await resp.json();
      if (deps.currentSessionId.value !== sessionId) return;
      if (result.data?.task_info) {
        sessionTaskInfo.value = result.data.task_info;
      }
      if (result.data?.observability) {
        mergeExecutionObservability(result.data.observability);
      }
    } catch (_) {
      // 状态同步失败不影响主流程
    }
  };

  /** 检查会话是否有正在执行的任务，若有则恢复 loading 状态 */
  const checkSessionTaskStatus = async (sessionId) => {
    if (!sessionId) return;
    try {
      const resp = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/task-status`);
      if (!resp.ok) return;
      const result = await resp.json();
      const hasRunningTask = Boolean(result.data?.has_running_task);
      const hasActiveSystemCommand = Boolean(result.data?.has_active_system_command);
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
      const activeRun = deps.getActiveRun();
      if (!hasRunningTask && !deps.isLoading.value) {
        if (deps.shouldRefreshFn({
          hasRunningTask,
          activeRun: activeRun.active,
          messages: deps.messages.value,
        })) {
          deps.invalidateActiveStream();
          deps.deleteMessageCache(sessionId);
          await deps.loadSessionMessages(sessionId, { silent: true });
        }
      }
      if (hasActiveSystemCommand && !deps.isLoading.value) {
        deps.isLoading.value = true;
        const lastMsg = deps.messages.value[deps.messages.value.length - 1];
        if (!lastMsg || lastMsg.role !== 'assistant' || !lastMsg.finished) {
          deps.messages.value.push(deps.createAssistantMessage());
        }
        activeRun.active = true;
        activeRun.assistantMsgIndex = deps.messages.value.length - 1;
        deps.scheduleCommandFallback(sessionId, activeRun.assistantMsgIndex, 120000);
      }
    } catch (e) {
      // 查询失败不影响主流程
    }
  };

  const clearExecutionState = () => {
    deps.clearLlmRetryState();
    sessionTaskInfo.value = null;
    sessionExecutionObservability.value = null;
    contextUsage.value = { used: 0, max: 0 };
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
    sessionTaskInfo,
    sessionExecutionObservability,
    contextUsage,
    buildObservabilityFromTaskInfo,
    mergeExecutionObservability,
    loadContextSnapshot,
    refreshSessionExecutionState,
    checkSessionTaskStatus,
    clearExecutionState,
    beginOptimisticExecutionState,
  };
}
