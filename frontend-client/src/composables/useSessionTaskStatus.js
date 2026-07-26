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
 * @param {Function} deps.mergeExecutionObservability - 运行期 observability 写入（client 提供）
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

  const loadContextSnapshot = async (sessionId) => {
    if (!sessionId) return;
    try {
      const json = await getContextSnapshot(sessionId);
      if (currentSessionId.value !== sessionId) return;
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
        deps.mergeExecutionObservability(result.data.observability);
      } else if (result.data?.task_info) {
        deps.mergeExecutionObservability(buildObservabilityFromTaskInfo(result.data.task_info));
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

  return {
    buildObservabilityFromTaskInfo,
    loadContextSnapshot,
    checkSessionTaskStatus,
    clearExecutionState,
  };
}
