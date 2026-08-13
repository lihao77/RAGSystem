import { createExecutionTreeState, applyEnvelope, getExecutionTree } from '@ragsystem/agent-protocol';
import { getCurrentScope, onScopeDispose, watch } from 'vue';
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

const getAgentMessageEventContent = (payload = {}) => {
  if (typeof payload.content === 'string' && payload.content) return payload.content;
  const parts = Array.isArray(payload.content_parts) ? payload.content_parts : [];
  return parts.flatMap((part) => {
    if (part?.type === 'text' && typeof part.text === 'string') return [part.text];
    if (part?.type === 'command_ref' && part.resolution?.kind === 'prompt') {
      return [part.resolution.agent_text || ''];
    }
    return [];
  }).filter(Boolean).join('\n').trim();
};

const createAgentMessageFromEvent = (event, participantId, consumedUserMessage = false) => {
  const payload = event?.payload || {};
  const content = getAgentMessageEventContent(payload);
  const metadata = payload.metadata || {};
  const consumedRunId = typeof metadata.consumed_by_run_id === 'string'
    ? metadata.consumed_by_run_id
    : null;
  return {
    role: 'user',
    id: payload.message_id || event?.message_id,
    seq: Number.isSafeInteger(payload.seq) ? payload.seq : undefined,
    run_id: consumedRunId,
    content,
    content_parts: [{ type: 'text', text: content }],
    finished: true,
    has_execution: Boolean(consumedRunId),
    executionTree: { root: null, steps: [] },
    executionStepsLoaded: false,
    executionStepsLoading: false,
    executionStepsLoadError: '',
    _execState: null,
    thread_key: payload.target_thread_key || metadata.target_thread_key,
    child_agent_id: participantId === 'root' ? null : participantId,
    metadata: {
      ...metadata,
      ...(consumedUserMessage ? {} : { agent_message: true }),
      ...(consumedRunId ? { run_id: consumedRunId } : {}),
      agent_message_display_content: content,
      mailbox_kind: payload.kind || metadata.mailbox_kind,
      agent_message_direction: payload.direction || metadata.direction || null,
      agent_message_source_agent_name: payload.source_agent_name || metadata.source_agent_name || null,
      agent_message_source_child_agent_id: payload.source_child_agent_id || metadata.source_child_agent_id || null,
      agent_message_target_agent_name: payload.target_agent_name || metadata.target_agent_name || null,
      agent_message_target_child_agent_id: payload.target_child_agent_id || null,
      agent_message_target_thread_key: payload.target_thread_key || metadata.target_thread_key || null,
      visible_to_user: consumedUserMessage ? metadata.visible_to_user !== false : false,
    },
  };
};

const executionTreeHasContent = (executionTree) => Boolean(executionTree?.root);

export const normalizeAssistantExecutionState = (msg) => {
  if (!msg || (msg.role !== 'assistant' && msg.role !== 'user')) return msg;
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
  const participantByRun = new Map();
  const pendingEnvelopesByRun = new Map();
  const participantReloads = new Map();
  const seenEnvelopeIds = new Map();

  const runKey = (sessionId, runId) => `${sessionId}\u0000${runId}`;
  const boundaryIdFromEnvelope = (event) => event?.boundary_message_id
    || event?.payload?.boundary_message_id
    || event?.payload?.metadata?.boundary_message_id
    || null;
  const getMessageRunId = message => message?.run_id
    || message?.metadata?.consumed_by_run_id
    || message?.metadata?.run_id
    || null;
  const participantIdFromMessage = (message) => {
    const threadKey = message?.thread_key
      || message?.metadata?.thread_key
      || message?.metadata?.target_thread_key
      || message?.metadata?.agent_message_target_thread_key;
    if (typeof threadKey === 'string') {
      if (threadKey === 'root') return 'root';
      if (threadKey.startsWith('child:')) {
        return threadKey.slice('child:'.length).split(':')[0] || 'root';
      }
    }
    const explicit = message?.child_agent_id || message?.metadata?.child_agent_id;
    return explicit || 'root';
  };
  const findParticipantBoundary = (participantId, runId) => {
    const list = deps.participantMessages?.value?.[participantId] || [];
    return list.findLast(message => (
      message?.role === 'user' && getMessageRunId(message) === runId
    )) || null;
  };
  const findBoundaryForEnvelope = (participantId, runId, event) => {
    const boundaryId = boundaryIdFromEnvelope(event);
    const list = deps.participantMessages?.value?.[participantId] || [];
    if (boundaryId) {
      return list.find(message => message?.role === 'user' && message.id === boundaryId) || null;
    }
    return findParticipantBoundary(participantId, runId);
  };

  // core ExecutionTreeState（增量投影状态机）懒挂在 msg._execState。
  const ensureExecutionTreeState = (msg) => {
    if (!msg._execState) {
      msg._execState = createExecutionTreeState();
    }
    return msg._execState;
  };

  const projectEnvelopeForMessage = (msg, envelope) => {
    const participantId = participantIdFromMessage(msg);
    const messageRunId = getMessageRunId(msg);
    if (!participantId || !messageRunId || envelope?.run_id !== messageRunId) return envelope;
    // 历史消息的边界可能从 model_request/stream_output 开始，不包含
    // agent_started。子线程的 lineage.parent_call_id 是外部父 run，不能
    // 让 core 在当前消息里创建一个假的父节点；用首个 agent 级事件补识别
    // 当前 run 的 root call，再统一剥离外部 lineage。
    const canIdentifyRootCall = envelope.type === 'agent_started'
      || envelope.type === 'model_request'
      || envelope.type === 'model_attempt_started'
      || envelope.type === 'model_attempt_completed'
      || envelope.type === 'stream_output'
      || envelope.type === 'agent_ended';
    if (!msg._executionRootCallId && canIdentifyRootCall && envelope.call_id) {
      const eventParticipantId = envelope.payload?.child_agent_id;
      if (envelope.type !== 'agent_started'
        || !eventParticipantId
        || eventParticipantId === participantId) {
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
    if (!msg?.id || !deps.currentSessionId.value || msg.executionStepsLoaded || msg.executionStepsLoading || !msg.has_execution) {
      return;
    }
    msg.executionStepsLoading = true;
    msg.executionStepsLoadError = '';
    try {
      if (!deps.chatSdkClient) throw new Error('Chat SDK 未初始化');
      const sessionId = deps.currentSessionId.value;
      const messageParticipantId = participantIdFromMessage(msg);
      const envelopes = [];
      let offset = 0;
      let hasMore = false;
      do {
        const result = await deps.chatSdkClient.getMessageRunSteps(
          sessionId,
          msg.id,
          {
            limit: 500,
            offset,
            ...(messageParticipantId && messageParticipantId !== 'root'
              ? { participantId: messageParticipantId }
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
      const state = createExecutionTreeState();
      for (const env of envelopes) applyEnvelope(state, projectEnvelopeForMessage(msg, env));
      msg.executionTree = getExecutionTree(state);
      msg._execState = state;
      msg.executionStepsLoaded = true;
    } catch (error) {
      msg.executionStepsLoadError = error?.message || '加载执行过程失败';
      throw error;
    } finally {
      msg.executionStepsLoading = false;
    }
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
  const applyParticipantEnvelope = (message, event) => {
    if (liveExecutionEventTypes.has(event.type) && event.type !== 'agent_message') {
      applyEnvelopeToMessage(message, event);
    }
    if (event.type === 'run_ended') {
      const status = event.payload?.status || 'completed';
      message.finished = status !== 'suspended';
      message.run_failed = status === 'failed';
      message.stopped = status === 'interrupted';
      message.metadata = { ...(message.metadata || {}), terminal_status: status };
    } else if (event.type !== 'agent_message') {
      message.finished = false;
    }
  };
  const flushParticipantRun = (sessionId, participantId, runId) => {
    const key = runKey(sessionId, runId);
    const pending = pendingEnvelopesByRun.get(key);
    const message = pending?.length
      ? findBoundaryForEnvelope(participantId, runId, pending[0])
      : null;
    if (!message || !pending?.length) return;
    for (const event of pending) applyParticipantEnvelope(message, event);
    pendingEnvelopesByRun.delete(key);
  };
  const reloadParticipantBoundary = (sessionId, participantId, runId) => {
    if (!deps.reloadParticipantMessages) return;
    const key = runKey(sessionId, runId);
    if (participantReloads.has(key)) return;
    const entry = { attempts: 0, timer: null, cancelled: false };
    const run = async () => {
      if (entry.cancelled || sessionId !== deps.currentSessionId.value) return;
      entry.attempts += 1;
      try {
        await deps.reloadParticipantMessages(sessionId, participantId, { reconcileMode: 'live' });
        if (!entry.cancelled) flushParticipantRun(sessionId, participantId, runId);
        if (!pendingEnvelopesByRun.has(key) || entry.cancelled) participantReloads.delete(key);
      } catch (error) {
        if (entry.cancelled || entry.attempts >= 4 || sessionId !== deps.currentSessionId.value) {
          participantReloads.delete(key);
          return;
        }
        entry.timer = setTimeout(() => { entry.timer = null; void run(); }, 250 * (2 ** (entry.attempts - 1)));
      }
    };
    participantReloads.set(key, entry);
    void run();
  };
  const unsubscribe = deps.chatSdkClient?.on?.('event', (event) => {
    const runId = event?.run_id;
    const sessionId = event?.session_id || deps.chatSdkClient?.sessionId || deps.currentSessionId.value;
    if (!runId || !sessionId || sessionId !== deps.currentSessionId.value) return;
    const eventIdentity = event?.event_id || event?.id || (event?.seq == null ? null : `${event.type}:${event.seq}`);
    const seenKey = eventIdentity == null ? null : runKey(sessionId, `${runId}\u0000${eventIdentity}`);
    if (seenKey && seenEnvelopeIds.has(seenKey)) return;
    if (seenKey) seenEnvelopeIds.set(seenKey, true);
    const participantId = event?.payload?.child_agent_id
      || event?.payload?.participant_id
      || (event?.type === 'agent_message' ? event?.payload?.target_child_agent_id : null)
      || event?.child_agent_id
      || participantByRun.get(runKey(sessionId, runId))
      || null;
    const metadata = event?.payload?.metadata || {};
    const isConsumedUserMessage = event.type === 'agent_message'
      && metadata.mailbox_message_id
      && metadata.agent_message !== true
      && metadata.visible_to_user !== false;
    if (event.type === 'agent_message') {
      const targetParticipantId = event?.payload?.target_child_agent_id || 'root';
      participantByRun.set(runKey(sessionId, runId), targetParticipantId);
      deps.syncParticipantMessage?.(
        targetParticipantId,
        createAgentMessageFromEvent(event, targetParticipantId, isConsumedUserMessage),
      );
      flushParticipantRun(sessionId, targetParticipantId, runId);
      return;
    }
    if (!participantId || participantId === 'root') return;
    participantByRun.set(runKey(sessionId, runId), participantId);
    const message = findBoundaryForEnvelope(participantId, runId, event);
    if (message) applyParticipantEnvelope(message, event);
    else {
      const key = runKey(sessionId, runId);
      pendingEnvelopesByRun.set(key, [...(pendingEnvelopesByRun.get(key) || []), event]);
      reloadParticipantBoundary(sessionId, participantId, runId);
    }
  });
  if (deps.participantMessages) {
    watch(deps.participantMessages, (allMessages) => {
      const sessionId = deps.currentSessionId.value;
      if (!sessionId) return;
      for (const [participantId, list] of Object.entries(allMessages || {})) {
        for (const message of list || []) {
          const runId = getMessageRunId(message);
          if (participantId !== 'root' && runId) flushParticipantRun(sessionId, participantId, runId);
        }
      }
    }, { deep: false });
  }
  watch(deps.currentSessionId, () => {
    participantByRun.clear();
    pendingEnvelopesByRun.clear();
    for (const entry of participantReloads.values()) {
      entry.cancelled = true;
      if (entry.timer) clearTimeout(entry.timer);
    }
    participantReloads.clear();
    seenEnvelopeIds.clear();
  });
  if (getCurrentScope()) onScopeDispose(() => {
    unsubscribe?.();
    for (const entry of participantReloads.values()) {
      entry.cancelled = true;
      if (entry.timer) clearTimeout(entry.timer);
    }
    participantReloads.clear();
  });

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
      has_execution: false,
      executionStepsLoaded: false,
      executionStepsLoading: false,
      executionStepsLoadError: '',
      run_id: item.metadata?.run_id || null,
      thread_key: item.thread_key,
      child_agent_id: item.child_agent_id ?? null,
      metadata: item.metadata || {},
      _execState: null,
    });
    return message;
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
    createAssistantMessageFromHistory,
    isRootEvent,
    isMasterEvent,
    findRunningExecutionAgentByAgentId,
    getMessageExecutionTimeText,
    getMessageExecutionTimeTitle,
  };
}
