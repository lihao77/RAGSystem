import { createExecutionTreeState, applyEnvelope, getExecutionTree } from '@ragsystem/agent-protocol';
import { getCurrentScope, onScopeDispose, reactive, ref, watch } from 'vue';
import {
  getMessageExecutionTimeText,
  getMessageExecutionTimeTitle,
  hasExecutionContent,
} from '../utils/message-render.js';

export const createAssistantMessage = (overrides = {}) => ({
  role: 'assistant',
  content: '',
  content_parts: [],
  executionTree: { root: null, steps: [] },
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
  _executionRootCallId: null,
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

export function useMessageExecution(deps) {
  const participantRunMessages = new Map();
  const participantRunOrder = new Map();
  const participantRunsLoaded = new Set();
  const participantRunsLoading = new Map();
  const participantRunRevision = ref(0);

  const participantKey = (participantId) => (
    participantId && deps.currentSessionId.value
      ? `${deps.currentSessionId.value}:${participantId}`
      : ''
  );

  const participantRunKey = (participantId, runId) => (
    participantId && runId && deps.currentSessionId.value
      ? `${deps.currentSessionId.value}:${participantId}:${runId}`
      : ''
  );

  const registerParticipantRunMessage = (participantId, runId, message) => {
    const key = participantRunKey(participantId, runId);
    if (!key) return message;
    const existing = participantRunMessages.get(key);
    if (!existing) {
      const carrier = reactive(message);
      participantRunMessages.set(key, carrier);
      return carrier;
    }
    if (existing === message) return existing;

    const executionState = existing._execState;
    const executionTree = existing.executionTree;
    const executionStepsLoaded = existing.executionStepsLoaded;
    const executionStepsLoading = existing.executionStepsLoading;
    const executionRootCallId = existing._executionRootCallId;
    const metadata = { ...(existing.metadata || {}), ...(message.metadata || {}) };
    Object.assign(existing, message, {
      executionParticipantId: participantId,
      _execState: executionState,
      executionTree,
      executionStepsLoaded,
      executionStepsLoading,
      _executionRootCallId: executionRootCallId,
      metadata,
      run_failed: Boolean(existing.run_failed || message.run_failed),
      stopped: Boolean(existing.stopped || message.stopped),
      has_execution: Boolean(existing.has_execution || message.has_execution),
    });
    return existing;
  };

  const getOrCreateParticipantRunMessage = (participantId, run) => {
    const runId = run?.run_id;
    if (!participantId || participantId === 'root' || !runId) return null;
    const key = participantRunKey(participantId, runId);
    let msg = participantRunMessages.get(key);
    if (!msg) {
      msg = reactive(createAssistantMessage({
        run_id: runId,
        has_execution: true,
        executionParticipantId: participantId,
        metadata: {
          run_id: runId,
          participant_id: participantId,
          execution_anchor: true,
        },
      }));
      participantRunMessages.set(key, msg);
    }
    const status = run.status || '';
    msg.finished = status !== 'running' && status !== 'suspended';
    msg.run_failed = status === 'failed';
    msg.stopped = status === 'interrupted';
    msg.metadata = {
      ...(msg.metadata || {}),
      run_id: runId,
      participant_id: participantId,
      execution_anchor: true,
      ...(run.task_summary ? { task_summary: run.task_summary } : {}),
      ...(run.created_at ? { run_created_at: run.created_at } : {}),
      ...(status ? { terminal_status: status } : {}),
    };
    return msg;
  };

  // core ExecutionTreeState（增量投影状态机）懒挂在 msg._execState。
  const ensureExecutionTreeState = (msg) => {
    if (!msg._execState) {
      msg._execState = createExecutionTreeState();
    }
    return msg._execState;
  };

  const projectEnvelopeForMessage = (msg, envelope) => {
    const participantId = msg?.executionParticipantId;
    const messageRunId = msg?.run_id || msg?.metadata?.run_id;
    if (!participantId || !messageRunId || envelope?.run_id !== messageRunId) return envelope;
    if (!msg._executionRootCallId && envelope.type === 'agent_started') {
      const eventParticipantId = envelope.payload?.child_agent_id;
      if (!eventParticipantId || eventParticipantId === participantId) {
        msg._executionRootCallId = envelope.call_id || null;
      }
    }
    if (!msg._executionRootCallId || envelope.call_id !== msg._executionRootCallId) return envelope;
    const lineage = envelope.payload?.lineage;
    if (!lineage?.parent_call_id) return envelope;
    const { parent_call_id: _externalParentCallId, ...localLineage } = lineage;
    return {
      ...envelope,
      payload: {
        ...envelope.payload,
        lineage: localLineage,
      },
    };
  };

  // 实时投影：把一条 Envelope 喂进 core 状态机，刷新 msg.executionTree。
  const applyEnvelopeToMessage = (msg, envelope) => {
    const state = ensureExecutionTreeState(msg);
    applyEnvelope(state, projectEnvelopeForMessage(msg, envelope));
    msg.executionTree = getExecutionTree(state);
    if (executionTreeHasContent(msg.executionTree)) msg.has_execution = true;
  };

  const ensureExecutionStepsLoaded = async (msg) => {
    const participantId = msg?.executionParticipantId || null;
    if (!msg || msg.role !== 'assistant' || (!msg.id && !participantId) || !deps.currentSessionId.value || msg.executionStepsLoaded || msg.executionStepsLoading || !msg.has_execution) {
      return;
    }
    msg.executionStepsLoading = true;
    msg.executionStepsLoadError = '';
    try {
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      const sessionId = deps.currentSessionId.value;
      const envelopes = [];
      let offset = 0;
      let hasMore = false;
      do {
        const result = participantId
          ? await deps.chatSdkClient.getParticipantRunSteps(
              sessionId,
              participantId,
              msg.run_id || msg.metadata?.run_id,
              { limit: 500, offset },
            )
          : await deps.chatSdkClient.getMessageRunSteps(
              sessionId,
              msg.id,
              {
                limit: 500,
                offset,
                ...(deps.selectedParticipantId?.value && deps.selectedParticipantId.value !== 'root'
                  ? { participantId: deps.selectedParticipantId.value }
                  : {}),
              },
            );
        if (deps.currentSessionId.value !== sessionId) return;
        const payload = result?.data || result;
        const pageItems = Array.isArray(payload?.items) ? payload.items : [];
        envelopes.push(...pageItems);
        offset += pageItems.length;
        hasMore = Boolean(payload?.has_more) && pageItems.length > 0;
      } while (hasMore);
      const state = ensureExecutionTreeState(msg);
      for (const env of envelopes) applyEnvelope(state, projectEnvelopeForMessage(msg, env));
      msg.executionTree = getExecutionTree(state);
      msg.executionStepsLoaded = true;
    } catch (error) {
      msg.executionStepsLoadError = error?.message || '加载执行过程失败';
      throw error;
    } finally {
      msg.executionStepsLoading = false;
    }
  };

  const getParticipantRunExecutionMessage = (participant) => {
    const participantId = participant?.participant_id;
    const runId = participant?.last_run_id;
    if (!participantId || participantId === 'root' || !runId) return null;
    const status = participant.last_run_status || participant.lifecycle_status || '';
    return getOrCreateParticipantRunMessage(participantId, { run_id: runId, status });
  };

  const ensureParticipantRunsLoaded = async (participant) => {
    const participantId = participant?.participant_id;
    const key = participantKey(participantId);
    if (!key || participantId === 'root' || participantRunsLoaded.has(key)) return;
    if (participantRunsLoading.has(key)) return participantRunsLoading.get(key);
    const sessionId = deps.currentSessionId.value;
    const request = (async () => {
      if (!deps.chatSdkClient?.listSessionParticipantRuns) throw new Error('Chat SDK 不支持 Participant Run 列表');
      const items = [];
      let offset = 0;
      let hasMore = false;
      do {
        const result = await deps.chatSdkClient.listSessionParticipantRuns(
          sessionId,
          participantId,
          { limit: 500, offset },
        );
        if (deps.currentSessionId.value !== sessionId) return;
        const pageItems = Array.isArray(result?.data?.items) ? result.data.items : [];
        items.push(...pageItems);
        offset += pageItems.length;
        hasMore = Boolean(result?.data?.has_more) && pageItems.length > 0;
      } while (hasMore);
      const chronological = [...items].reverse();
      participantRunOrder.set(key, chronological.map(item => item.run_id));
      for (const item of chronological) getOrCreateParticipantRunMessage(participantId, item);
      participantRunsLoaded.add(key);
      participantRunRevision.value += 1;
    })().finally(() => participantRunsLoading.delete(key));
    participantRunsLoading.set(key, request);
    return request;
  };

  const getParticipantRunExecutionMessages = (participant) => {
    participantRunRevision.value;
    const participantId = participant?.participant_id;
    if (!participantId || participantId === 'root') return [];
    const latest = getParticipantRunExecutionMessage(participant);
    const order = participantRunOrder.get(participantKey(participantId)) || [];
    const messages = order
      .map(runId => participantRunMessages.get(participantRunKey(participantId, runId)))
      .filter(Boolean);
    if (latest && !messages.includes(latest)) messages.push(latest);
    return messages;
  };

  const liveExecutionEventTypes = new Set([
    'agent_started',
    'agent_ended',
    'model_request',
    'model_attempt_started',
    'model_attempt_failed',
    'model_attempt_completed',
    'stream_output',
    'tool_call',
    'tool_result',
    'agent_message',
  ]);
  const unsubscribe = deps.chatSdkClient?.on?.('event', (event) => {
    const runId = event?.run_id;
    const sessionId = event?.session_id || deps.chatSdkClient?.sessionId || deps.currentSessionId.value;
    if (!runId || !sessionId || sessionId !== deps.currentSessionId.value) return;
    const participantId = event?.payload?.child_agent_id
      || event?.payload?.participant_id
      || event?.child_agent_id
      || null;
    const msg = participantId
      ? participantRunMessages.get(`${sessionId}:${participantId}:${runId}`)
      : [...participantRunMessages.entries()].find(([key]) => key.startsWith(`${sessionId}:`) && key.endsWith(`:${runId}`))?.[1];
    if (!msg) return;
    if (liveExecutionEventTypes.has(event.type)) applyEnvelopeToMessage(msg, event);
    if (event.type === 'run_ended') {
      const status = event.payload?.status || 'completed';
      msg.finished = status !== 'suspended';
      msg.run_failed = status === 'failed';
      msg.stopped = status === 'interrupted';
      msg.metadata = { ...(msg.metadata || {}), terminal_status: status };
    }
  });
  watch(deps.currentSessionId, () => {
    participantRunMessages.clear();
    participantRunOrder.clear();
    participantRunsLoaded.clear();
    participantRunsLoading.clear();
    participantRunRevision.value += 1;
  });
  if (getCurrentScope()) onScopeDispose(() => unsubscribe?.());

  const createAssistantMessageFromHistory = (item) => {
    const terminalStatus = item.metadata?.terminal_status || null;
    const interrupted = terminalStatus === 'interrupted';
    const failed = terminalStatus === 'failed';
    const message = createAssistantMessage({
      id: item.id,
      seq: item.seq,
      content: item.content || '',
      content_parts: Array.isArray(item.content_parts) ? item.content_parts : [],
      executionTree: { root: null, steps: [] },
      status: item.status || [],
      finished: true,
      stopped: interrupted,
      run_failed: failed,
      has_execution: Boolean(item.has_execution || item.metadata?.run_id),
      executionStepsLoaded: false,
      executionStepsLoading: false,
      executionStepsLoadError: '',
      run_id: item.metadata?.run_id || null,
      metadata: item.metadata || {},
      _execState: null,
    });
    const threadKey = item.thread_key || item.metadata?.thread_key || '';
    const participantId = item.child_agent_id
      || item.metadata?.child_agent_id
      || (threadKey.startsWith('child:') ? threadKey.slice('child:'.length) : null);
    return participantId
      ? registerParticipantRunMessage(participantId, message.run_id, message)
      : message;
  };

  // root/master 判定：先按 root run_id 隔离 child run。工具事件的 lineage
  // 指向所属 agent，因此 root 工具也有 parent_call_id，必须与 rootCallId 对齐。
  const isRootEvent = (event) => {
    const scope = event?.payload?.conversation_scope;
    if (scope === 'child' || event?.payload?.thread_key?.startsWith?.('child:')) return false;
    const activeRootRunId = deps.activeRun?.runId || null;
    const eventRunId = event?.run_id || null;
    if (activeRootRunId && eventRunId && activeRootRunId !== eventRunId) return false;
    const parentCallId = event?.payload?.lineage?.parent_call_id || null;
    if (!parentCallId) return true;
    if (event?.type === 'tool_call' || event?.type === 'tool_result') {
      return Boolean(deps.activeRun?.rootCallId && deps.activeRun.rootCallId === parentCallId);
    }
    return false;
  };
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

  return {
    createAssistantMessage,
    normalizeAssistantExecutionState,
    hasExecutionContent,
    ensureExecutionTreeState,
    applyEnvelopeToMessage,
    ensureExecutionStepsLoaded,
    getParticipantRunExecutionMessage,
    getParticipantRunExecutionMessages,
    ensureParticipantRunsLoaded,
    createAssistantMessageFromHistory,
    isRootEvent,
    isMasterEvent,
    findRunningExecutionAgentByAgentId,
    getMessageExecutionTimeText,
    getMessageExecutionTimeTitle,
  };
}
