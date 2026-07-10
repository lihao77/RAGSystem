import { createExecutionTreeState, applyEnvelope, getExecutionTree } from '@ragsystem/agent-protocol';
import { getMessageRunSteps } from '../api/monitoring.js';

export const createAssistantMessage = (overrides = {}) => ({
  role: 'assistant',
  content: '',
  executionTree: { root: null, steps: [] },
  showFullSubtasks: false,
  status: [],
  finished: false,
  has_execution: false,
  executionStepsLoaded: false,
  executionStepsLoading: false,
  executionStepsLoadError: '',
  run_id: null,
  run_failed: false,
  metadata: {},
  _execState: null,
  ...overrides,
});

const executionTreeHasContent = (executionTree) => Boolean(executionTree?.root);

export const normalizeAssistantExecutionState = (msg) => {
  if (!msg || msg.role !== 'assistant') return msg;
  const metadata = msg.metadata || {};
  if (!msg.executionTree) msg.executionTree = { root: null, steps: [] };
  if (msg._execState === undefined) msg._execState = null;
  msg.has_execution = Boolean(
    msg.has_execution
    || msg.run_id
    || metadata.run_id
    || executionTreeHasContent(msg.executionTree)
  );
  msg.executionStepsLoaded = Boolean(msg.executionStepsLoaded);
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
    return Boolean(msg.has_execution) || executionTreeHasContent(msg.executionTree);
  };

  // core ExecutionTreeState（增量投影状态机）懒挂在 msg._execState。
  const ensureExecutionTreeState = (msg) => {
    if (!msg._execState) {
      msg._execState = createExecutionTreeState();
    }
    return msg._execState;
  };

  // 实时投影：把一条 Envelope 喂进 core 状态机，刷新 msg.executionTree。
  const applyEnvelopeToMessage = (msg, envelope) => {
    const state = ensureExecutionTreeState(msg);
    applyEnvelope(state, envelope);
    msg.executionTree = getExecutionTree(state);
    if (executionTreeHasContent(msg.executionTree)) msg.has_execution = true;
  };

  const ensureExecutionStepsLoaded = async (msg) => {
    if (!msg || !msg.id || !deps.currentSessionId.value || msg.executionStepsLoaded || msg.executionStepsLoading || !msg.has_execution) {
      return;
    }
    msg.executionStepsLoading = true;
    msg.executionStepsLoadError = '';
    try {
      const payload = await getMessageRunSteps(deps.currentSessionId.value, msg.id, { limit: 500, offset: 0 });
      const envelopes = Array.isArray(payload?.items) ? payload.items : [];
      const state = ensureExecutionTreeState(msg);
      for (const env of envelopes) applyEnvelope(state, env);
      msg.executionTree = getExecutionTree(state);
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
      executionTree: { root: null, steps: [] },
      status: interrupted ? [{ type: 'error', content: '已中断' }] : (item.status || []),
      finished: true,
      stopped: interrupted,
      has_execution: Boolean(item.has_execution || item.metadata?.run_id),
      executionStepsLoaded: false,
      executionStepsLoading: false,
      executionStepsLoadError: '',
      run_id: item.metadata?.run_id || null,
      metadata: item.metadata || {},
      _execState: null,
    });
  };

  // root/master 判定：无 lineage.parent_call_id 即根（顶层 orchestrator）。
  const isRootEvent = (event) => !(event?.payload?.lineage?.parent_call_id);
  const isMasterEvent = (event) => isRootEvent(event);

  // 按 agentId 找 status=running 的 agent（context_usage 挂 ctx 用）。
  const findRunningExecutionAgentByAgentId = (executionTree, agentId) => {
    if (!agentId || !executionTree?.root) return null;
    const stack = [executionTree.root];
    while (stack.length > 0) {
      const agent = stack.shift();
      if (!agent) continue;
      if (agent.agentId === agentId && agent.status === 'running') return agent;
      if (Array.isArray(agent.children) && agent.children.length > 0) {
        stack.unshift(...agent.children);
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
    ensureExecutionTreeState,
    applyEnvelopeToMessage,
    ensureExecutionStepsLoaded,
    toggleExecutionView,
    createAssistantMessageFromHistory,
    isRootEvent,
    isMasterEvent,
    findRunningExecutionAgentByAgentId,
    getMessageExecutionTimeText,
    getMessageExecutionTimeTitle,
  };
}
