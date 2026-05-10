import { buildExecutionState, createExecutionState } from '../utils/executionProjector';
import { getMessageRunSteps } from '../api/monitoring';

export const createAssistantMessage = (overrides = {}) => ({
  role: 'assistant',
  content: '',
  subtasks: [],
  execution_steps: [],
  showFullSubtasks: false,
  status: [],
  finished: false,
  has_execution: false,
  executionStepsLoaded: false,
  executionStepsLoading: false,
  executionStepsLoadError: '',
  run_id: null,
  metadata: {},
  ...overrides,
});

export const normalizeAssistantExecutionState = (msg) => {
  if (!msg || msg.role !== 'assistant') return msg;
  const metadata = msg.metadata || {};
  msg.has_execution = Boolean(
    msg.has_execution
    || msg.run_id
    || metadata.run_id
    || (Array.isArray(msg.execution_steps) && msg.execution_steps.length > 0)
    || (Array.isArray(msg.subtasks) && msg.subtasks.length > 0)
  );
  msg.executionStepsLoaded = Boolean(
    msg.executionStepsLoaded
    || (Array.isArray(msg.execution_steps) && msg.execution_steps.length > 0)
    || (Array.isArray(msg.subtasks) && msg.subtasks.length > 0)
  );
  msg.executionStepsLoading = Boolean(msg.executionStepsLoading);
  msg.executionStepsLoadError = msg.executionStepsLoadError || '';
  msg.run_id = msg.run_id || metadata.run_id || null;
  return msg;
};

const getMessageExecutionTime = (msg) => {
  const value = msg?.metadata?.execution_time;
  if (value == null || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const getMessageFirstTokenTime = (msg) => {
  const value = msg?.metadata?.first_token_time;
  if (value == null || value === '') return null;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null;
};

const formatExecutionTime = (seconds) => {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const restSeconds = Math.round(seconds % 60);
  return `${minutes}m ${String(restSeconds).padStart(2, '0')}s`;
};

const formatPreciseExecutionTime = (seconds) => {
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  return `${seconds.toFixed(3)}s`;
};

export function useMessageExecution(deps) {
  const hasExecutionContent = (msg) => {
    if (!msg || msg.role !== 'assistant') return false;
    return Boolean(
      msg.has_execution
      || (Array.isArray(msg.subtasks) && msg.subtasks.length > 0)
      || (Array.isArray(msg.execution_steps) && msg.execution_steps.length > 0)
    );
  };

  const ensureExecutionProjector = (msg) => {
    if (!msg._executionProjector) {
      msg._executionProjector = createExecutionState();
    }
    return msg._executionProjector;
  };

  const syncExecutionProjection = (msg) => {
    const state = ensureExecutionProjector(msg);
    msg.subtasks = state.subtasks;
    msg.execution_steps = state.execution_steps;
    msg.has_execution = state.rawSteps.length > 0 || msg.has_execution;
  };

  const ensureExecutionStepsLoaded = async (msg) => {
    if (!msg || !msg.id || !deps.currentSessionId.value || msg.executionStepsLoaded || msg.executionStepsLoading || !msg.has_execution) {
      return;
    }
    msg.executionStepsLoading = true;
    msg.executionStepsLoadError = '';
    try {
      const payload = await getMessageRunSteps(deps.currentSessionId.value, msg.id, { limit: 500, offset: 0 });
      const executionSteps = Array.isArray(payload?.items) ? payload.items : [];
      const projected = buildExecutionState(executionSteps);
      msg._executionProjector = projected;
      msg.subtasks = projected.subtasks;
      msg.execution_steps = projected.execution_steps;
      msg.executionStepsLoaded = true;
    } catch (error) {
      msg.executionStepsLoadError = error?.message || '加载执行过程失败';
      throw error;
    } finally {
      msg.executionStepsLoading = false;
    }
  };

  const toggleExecutionView = async (msg) => {
    if (!msg) return;
    if (msg.showFullSubtasks) {
      msg.showFullSubtasks = false;
      return;
    }
    if (msg.has_execution && !msg.executionStepsLoaded) {
      try {
        await ensureExecutionStepsLoaded(msg);
      } catch (_) {
        deps.showToast(msg.executionStepsLoadError || '加载执行过程失败');
        return;
      }
    }
    msg.showFullSubtasks = true;
  };

  const createAssistantMessageFromHistory = (item) => {
    const interrupted = Boolean(item.metadata?.interrupted);
    return createAssistantMessage({
      id: item.id,
      seq: item.seq,
      content: interrupted ? '' : (item.content || ''),
      subtasks: [],
      execution_steps: [],
      status: interrupted ? [{ type: 'error', content: '已中断' }] : (item.status || []),
      finished: true,
      stopped: interrupted,
      has_execution: Boolean(item.has_execution || item.metadata?.run_id),
      executionStepsLoaded: false,
      executionStepsLoading: false,
      executionStepsLoadError: '',
      run_id: item.metadata?.run_id || null,
      metadata: item.metadata || {},
      _executionProjector: null,
    });
  };

  const isRootEvent = (event) => !(event?.parent_call_id || event?.data?.parent_call_id);
  const isMasterEvent = (event) => isRootEvent(event);

  const findSubtaskByCallId = (subtasks, callId) => {
    if (!callId || !Array.isArray(subtasks)) return null;
    const stack = [...subtasks];
    while (stack.length > 0) {
      const subtask = stack.shift();
      if (!subtask) continue;
      if (subtask.task_id === callId) return subtask;
      if (Array.isArray(subtask.children) && subtask.children.length > 0) {
        stack.unshift(...subtask.children);
      }
    }
    return null;
  };

  const findRunningSubtaskByAgentName = (subtasks, agentName) => {
    if (!agentName || !Array.isArray(subtasks)) return null;
    const stack = [...subtasks];
    while (stack.length > 0) {
      const subtask = stack.shift();
      if (!subtask) continue;
      if (subtask.agent_name === agentName && subtask.status === 'running') return subtask;
      if (Array.isArray(subtask.children) && subtask.children.length > 0) {
        stack.unshift(...subtask.children);
      }
    }
    return null;
  };

  const getMessageExecutionTimeText = (msg) => {
    const seconds = getMessageExecutionTime(msg);
    return seconds == null ? '' : `响应时间 ${formatExecutionTime(seconds)}`;
  };

  const getMessageExecutionTimeTitle = (msg) => {
    const executionTime = getMessageExecutionTime(msg);
    if (executionTime == null) return '';
    const lines = [`Run 执行时间：${formatPreciseExecutionTime(executionTime)}`];
    const firstTokenTime = getMessageFirstTokenTime(msg);
    if (firstTokenTime != null) {
      lines.push(`首 token：${formatPreciseExecutionTime(firstTokenTime)}`);
    }
    return lines.join('\n');
  };

  return {
    createAssistantMessage,
    normalizeAssistantExecutionState,
    hasExecutionContent,
    ensureExecutionProjector,
    syncExecutionProjection,
    ensureExecutionStepsLoaded,
    toggleExecutionView,
    createAssistantMessageFromHistory,
    isRootEvent,
    isMasterEvent,
    findSubtaskByCallId,
    findRunningSubtaskByAgentName,
    getMessageExecutionTimeText,
    getMessageExecutionTimeTitle,
  };
}
