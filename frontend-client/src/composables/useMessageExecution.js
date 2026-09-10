import { createExecutionTreeState, applyEnvelope, getExecutionTree } from '@ragsystem/agent-protocol';
import { getCurrentScope, onScopeDispose, watch } from 'vue';
import { partsToPlainText, reconcileMessageContentParts } from '../utils/messageContentParts.js';
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

const createAssistantMessageFromSavedEvent = (event, participantId) => {
  const ref = event?.payload?.ref || {};
  const contentParts = Array.isArray(ref.content_parts) ? ref.content_parts : [];
  const content = contentParts
    .filter(part => part?.type === 'text' && typeof part.text === 'string')
    .map(part => part.text)
    .join('');
  const runId = event?.run_id || null;
  return createAssistantMessage({
    id: ref.message_id || ref.id || null,
    seq: Number.isSafeInteger(ref.seq) ? ref.seq : undefined,
    content,
    content_parts: contentParts,
    finished: true,
    has_execution: false,
    run_id: runId,
    thread_key: `child:${participantId}`,
    child_agent_id: participantId,
    metadata: {
      ...(ref.metadata && typeof ref.metadata === 'object' ? ref.metadata : {}),
      run_id: runId,
      thread_key: `child:${participantId}`,
      child_agent_id: participantId,
    },
  });
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
    has_execution: false,
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
  // run_id 仅用于路由；不能把服务端明确的无执行内容重新水合成懒加载入口。
  msg.has_execution = Boolean(
    msg.has_execution
    || executionTreeHasContent(msg.executionTree)
  );
  msg.executionStepsLoaded = Boolean(msg.executionStepsLoaded);
  msg.executionStepsLoading = Boolean(msg.executionStepsLoading);
  msg.executionStepsLoadError = msg.executionStepsLoadError || '';
  msg.run_id = msg.run_id || metadata.consumed_by_run_id || metadata.run_id || null;
  return msg;
};

export function useMessageExecution(deps) {
  const participantByRun = new Map();
  const pendingEnvelopesByRun = new Map();
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
      // 执行视图来自消息行合成（思考=thinking part 一等内容），不再分页回放 run-steps 归档。
      const result = await deps.chatSdkClient.getMessageExecution(
        sessionId,
        msg.id,
        (messageParticipantId && messageParticipantId !== 'root')
          ? { participantId: messageParticipantId }
          : {},
      );
      if (deps.currentSessionId.value !== sessionId) return;
      const payload = result?.data || result;
      const envelopes = Array.isArray(payload?.items) ? payload.items : [];
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
  ]);
  const applyParticipantEnvelope = (message, event) => {
    if (liveExecutionEventTypes.has(event.type)) {
      applyEnvelopeToMessage(message, event);
    }
    if (event.type === 'run_ended') {
      const status = event.payload?.status || 'completed';
      message.finished = status !== 'suspended';
      message.run_failed = status === 'failed';
      message.stopped = status === 'interrupted';
      message.metadata = { ...(message.metadata || {}), terminal_status: status };
    } else if (message.role === 'assistant') {
      message.finished = false;
    }
  };
  // 子 run 消息槽载体：与 root 的投递口径对齐——root 从 run 开始就持有 assistant 气泡、
  // final 相位全文直达、message_saved 只合并 id/seq。子线程此前没有气泡载体，最终答案
  // 全靠 message_saved 整块造泡，事件丢失就得 HTTP 补拉；载体补齐后两条路径同构。
  const findParticipantRunCarrier = (participantId, runId) => {
    const list = deps.participantMessages?.value?.[participantId];
    if (!Array.isArray(list)) return null;
    return list.find(item => item?.role === 'assistant' && getMessageRunId(item) === runId) || null;
  };
  const ensureParticipantRunCarrier = (participantId, runId) => {
    const existing = findParticipantRunCarrier(participantId, runId);
    if (existing) return existing;
    const carrier = createAssistantMessage({
      run_id: runId,
      thread_key: `child:${participantId}`,
      child_agent_id: participantId,
      metadata: {
        run_id: runId,
        thread_key: `child:${participantId}`,
        child_agent_id: participantId,
      },
    });
    deps.syncParticipantMessage?.(participantId, carrier);
    return carrier;
  };
  const applyChildRunEnvelopeToCarrier = (participantId, runId, event) => {
    if (event.type === 'agent_started' || event.type === 'stream_output') {
      const carrier = ensureParticipantRunCarrier(participantId, runId);
      // final 是终局一次性帧（每 run 恰一条），全文直达气泡——镜像 sessionEventReducer
      // 根路径的 final 写入；后续 message_saved 经 run_id 去重只合并 id/seq。
      if (event.type === 'stream_output' && event.payload?.phase === 'final') {
        const payload = event.payload || {};
        if (typeof payload.content === 'string' && payload.content) carrier.content = payload.content;
        if (Array.isArray(payload.content_parts)) reconcileMessageContentParts(carrier, payload.content_parts);
        carrier.finished = true;
      }
      return;
    }
    if (event.type === 'run_ended') {
      const carrier = findParticipantRunCarrier(participantId, runId);
      if (!carrier) return;
      const status = event.payload?.status || 'completed';
      // 失败/中断 run 同样有终局 final 文本（先到、已定格 finished），此处不得按
      // finished 早退——run_failed/stopped/terminal_status 必须无条件补齐，
      // 否则失败旗标永远缺失，且重载历史（带 terminal_status）后前后不一致。
      if (status !== 'suspended') carrier.finished = true;
      carrier.run_failed = status === 'failed';
      carrier.stopped = status === 'interrupted';
      carrier.metadata = { ...(carrier.metadata || {}), terminal_status: status };
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
      || event?.participant_id
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
      // 根用户插嘴由 dispatcher 统一插入、排序和结束请求；两位写入者会令
      // 缺 seq 的消费消息先落到 assistant 后方，随后找不到正确的执行边界。
      if (targetParticipantId === 'root' && isConsumedUserMessage) return;
      deps.syncParticipantMessage?.(
        targetParticipantId,
        createAgentMessageFromEvent(event, targetParticipantId, isConsumedUserMessage),
      );
      flushParticipantRun(sessionId, targetParticipantId, runId);
      return;
    }
    if (event.type === 'state_sync'
      && event.payload?.category === 'message_saved'
      && event.payload?.ref?.role === 'assistant'
      && participantId
      && participantId !== 'root') {
      deps.syncParticipantMessage?.(
        participantId,
        createAssistantMessageFromSavedEvent(event, participantId),
      );
      return;
    }
    if (!participantId || participantId === 'root') return;
    participantByRun.set(runKey(sessionId, runId), participantId);
    applyChildRunEnvelopeToCarrier(participantId, runId, event);
    const message = findBoundaryForEnvelope(participantId, runId, event);
    if (message) applyParticipantEnvelope(message, event);
    else {
      const key = runKey(sessionId, runId);
      pendingEnvelopesByRun.set(key, [...(pendingEnvelopesByRun.get(key) || []), event]);
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
    seenEnvelopeIds.clear();
  });
  if (getCurrentScope()) onScopeDispose(() => {
    unsubscribe?.();
  });

  const createAssistantMessageFromHistory = (item) => {
    const terminalStatus = item.metadata?.terminal_status || null;
    const interrupted = terminalStatus === 'interrupted';
    const failed = terminalStatus === 'failed';
    const message = createAssistantMessage({
      id: item.id,
      seq: item.seq,
      content: partsToPlainText(item.content_parts),
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
