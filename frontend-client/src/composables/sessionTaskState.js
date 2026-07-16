// @ts-check
import { getSessionTaskStatus } from '../api/session.js';

/** @typedef {import('vue').Ref<any>} AnyRef */
/** @typedef {Record<string, any>} AnyRecord */

/**
 * @param {{
 *   currentSessionId: AnyRef,
 *   sessionTaskInfo: AnyRef,
 *   sessionExecutionObservability: AnyRef,
 *   fetchTaskStatus?: (sessionId: string) => Promise<any>,
 *   warn?: (...args: any[]) => void,
 * }} options
 */
export function createSessionTaskState({
  currentSessionId,
  sessionTaskInfo,
  sessionExecutionObservability,
  fetchTaskStatus = getSessionTaskStatus,
  warn = console.warn,
}) {
  /** @param {AnyRecord} [payload] */
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

  /** @param {AnyRecord} [patch] */
  const patchTaskInfo = (patch = {}) => {
    sessionTaskInfo.value = {
      ...(sessionTaskInfo.value || {}),
      ...patch,
    };
  };

  /** @param {string} sessionId */
  const refreshSessionExecutionState = async (sessionId) => {
    if (!sessionId) return;
    try {
      const result = await fetchTaskStatus(sessionId);
      if (currentSessionId.value !== sessionId) return;
      if (result.data?.task_info) {
        sessionTaskInfo.value = result.data.task_info;
      }
      if (result.data?.observability) {
        mergeExecutionObservability(result.data.observability);
      }
    } catch (error) {
      warn('refreshSessionExecutionState 状态同步失败:', error instanceof Error ? error.message : String(error));
    }
  };

  /** @param {string} sessionId */
  const beginOptimisticExecutionState = (sessionId) => {
    patchTaskInfo({
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
    });
    mergeExecutionObservability({
      task_id: null,
      session_id: sessionId,
      run_id: null,
      execution_kind: 'agent_stream',
      request_id: null,
    });
  };

  return {
    mergeExecutionObservability,
    patchTaskInfo,
    refreshSessionExecutionState,
    beginOptimisticExecutionState,
  };
}
