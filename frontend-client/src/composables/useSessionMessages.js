import { ref, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { getMessageAttachments, normalizeMessageContentParts } from '../utils/messageContentParts.js';

const AGENT_MESSAGE_WRAPPER = /^\[agent-message[^\]]*\]\r?\n([\s\S]*?)\r?\n\[\/agent-message\]\s*$/;

export function getAgentMessageDisplayContent(item) {
  const metadataContent = item?.metadata?.agent_message_display_content;
  if (typeof metadataContent === 'string') return metadataContent;
  const content = typeof item?.content === 'string' ? item.content : '';
  return content.match(AGENT_MESSAGE_WRAPPER)?.[1] ?? content;
}

/**
 * 会话消息加载、缓存、合并。
 *
 * messages 取自 useSessionRunStore 单源；本 composable 只承载加载/缓存/合并行为。
 *
 * @param {Object} deps
 * @param {Function} deps.normalizeAssistantExecutionState
 * @param {Function} deps.createAssistantMessageFromHistory
 * @param {Function} deps.normalizeAttachment
 * @param {Function} deps.scrollToBottom
 * @param {Function} deps.waitForScrollLayout
 * @param {Function} deps.focusInput
 * @param {Function} deps.loadContextSnapshot
 * @param {Function} deps.showToast
 * @param {Function} deps.invalidateActiveStream
 * @param {Function} [deps.shouldReplayActiveRun]
 * @param {Function} [deps.replayActiveRun]
 * @param {Function} [deps.beginInitialScrollRestore]
 * @param {Function} [deps.endInitialScrollRestore]
 */
export function useSessionMessages(deps) {
  const { currentSessionId, selectedParticipantId, rootMessages } = storeToRefs(useSessionRunStore());
  const sessionRunStore = useSessionRunStore();
  const messageCache = ref(new Map());
  const messagesLoading = ref(false);
  const maxCachedSessions = 10;
  let messageLoadSeq = 0;
  let messageMergeSeq = 0;

  const cacheKey = (sessionId, participantId = 'root') => `${sessionId}::${participantId || 'root'}`;

  const cacheMessages = (sessionId, list, participantId = 'root') => {
    if (!sessionId) return;
    const key = cacheKey(sessionId, participantId);
    if (messageCache.value.has(key)) {
      messageCache.value.delete(key);
    }
    messageCache.value.set(
      key,
      list.slice(-500).map(item => deps.normalizeAssistantExecutionState(item))
    );
    if (messageCache.value.size > maxCachedSessions) {
      const oldestKey = messageCache.value.keys().next().value;
      messageCache.value.delete(oldestKey);
    }
  };

  const deleteMessageCache = (sessionId) => {
    for (const key of messageCache.value.keys()) {
      if (key.startsWith(`${sessionId}::`)) messageCache.value.delete(key);
    }
  };

  /**
   * 只负责消息列表与缓存，不负责 Session 生命周期。
   * 进入/切换会话时由 WebSocket 首帧 session.runtime 决定后续加载策略。
   */
  const loadSessionMessages = async (sessionId, { silent = false, participantId = 'root', preserveStream = false } = {}) => {
    if (!sessionId) return null;
    const targetParticipantId = participantId || 'root';
    const seq = ++messageLoadSeq;
    const isCurrent = () => seq === messageLoadSeq
      && currentSessionId.value === sessionId
      && (silent || selectedParticipantId.value === targetParticipantId);
    let scrollRestoreStarted = false;
    let scrollRestoreEnded = false;
    const endScrollRestore = () => {
      if (!scrollRestoreStarted || scrollRestoreEnded) return;
      deps.endInitialScrollRestore?.();
      scrollRestoreEnded = true;
    };

    if (!silent) {
      if (!preserveStream) deps.invalidateActiveStream();
      deps.beginInitialScrollRestore?.();
      scrollRestoreStarted = true;
      messagesLoading.value = true;
    }
    try {
      // 非静默加载（路由切换/手动刷新）始终绕过缓存，确保拿到最新数据
      const cached = silent ? messageCache.value.get(cacheKey(sessionId, targetParticipantId)) : null;
      if (cached) {
        if (!isCurrent()) return;
        const restored = cached.map(item => deps.normalizeAssistantExecutionState(item));
        if (targetParticipantId !== 'root' || preserveStream) {
          sessionRunStore.reconcileParticipantMessages(targetParticipantId, restored);
        } else {
          sessionRunStore.setParticipantMessages(targetParticipantId, restored);
        }
        messagesLoading.value = false;
        await nextTick();
        if (!isCurrent()) return;
        await deps.scrollToBottom(true, 'auto');
        if (!isCurrent()) return;
        await deps.waitForScrollLayout();
        if (!isCurrent()) return;
        await deps.scrollToBottom(true, 'auto');
        if (!isCurrent()) return;
        endScrollRestore();
        deps.focusInput();
        return;
      }
      const client = deps.chatSdkClient;
      if (!client) throw new Error('Chat SDK 未初始化');
      const result = await client.listMessages(
        sessionId,
        targetParticipantId === 'root' ? {} : { participantId: targetParticipantId },
      );
      const items = result.data?.items || [];
      const rawOutboxWatermark = Number(result.data?.outbox_watermark);
      const outboxWatermark = Number.isSafeInteger(rawOutboxWatermark) && rawOutboxWatermark >= 0
        ? rawOutboxWatermark
        : 0;
      const mapped = items
        .filter(item => {
          const meta = item.metadata || {};
          if (meta.visible_to_user === false && !meta.display_only && meta.agent_message !== true) return false;
          if (meta.hidden === true || meta.react_intermediate === true) return false;
          // Tool observations are execution/context records, not chat bubbles.
          // They are rendered through the assistant message's execution tree.
          if (item.role === 'tool') return false;
          return true;
        })
        .map(item => {
          if (item.role === 'assistant') {
            return deps.createAssistantMessageFromHistory(item);
          }
          if (item.role === 'system') {
            return {
              role: 'system',
              id: item.id,
              seq: item.seq,
              content: item.content || '',
              content_parts: normalizeMessageContentParts(item.content_parts),
              metadata: item.metadata || {},
            };
          }
          const contentParts = normalizeMessageContentParts(item.content_parts);
          const metadata = item.metadata || {};
          const agentMessage = metadata.agent_message === true;
          const content = agentMessage ? getAgentMessageDisplayContent(item) : (item.content || '');
          const message = {
            role: 'user',
            id: item.id,
            seq: item.seq,
            content,
            content_parts: agentMessage ? [{ type: 'text', text: content }] : contentParts,
            finished: true,
            has_execution: Boolean(item.has_execution),
            executionTree: { root: null, steps: [] },
            executionStepsLoaded: false,
            executionStepsLoading: false,
            executionStepsLoadError: '',
            run_id: metadata.consumed_by_run_id || metadata.run_id || null,
            _execState: null,
            metadata: agentMessage
              ? { ...metadata, agent_message_display_content: content }
              : metadata,
          };
          return { ...message, attachments: getMessageAttachments(message) };
        });
      if (!isCurrent()) return;
      const nextMessages = targetParticipantId !== 'root' || preserveStream
        ? sessionRunStore.reconcileParticipantMessages(targetParticipantId, mapped)
        : sessionRunStore.setParticipantMessages(targetParticipantId, mapped);
      cacheMessages(sessionId, nextMessages, targetParticipantId);
      messagesLoading.value = false;
      await nextTick();
      await nextTick();
      if (!isCurrent()) return;
      await deps.scrollToBottom(true, 'auto');
      if (!isCurrent()) return;
      await deps.waitForScrollLayout();
      if (!isCurrent()) return;
      await deps.scrollToBottom(true, 'auto');
      if (!isCurrent()) return;
      endScrollRestore();
      deps.focusInput();
      if (!silent && !preserveStream) {
        await deps.loadContextSnapshot(sessionId);
        // 手动重载消息会替换 messages，active run 的执行树不在聊天消息接口中；
        // 由当前权威 runtime 决定是否重新请求 active-run 快照。
        if (deps.shouldReplayActiveRun?.(sessionId)) {
          await deps.replayActiveRun?.(sessionId);
        }
      }
      return outboxWatermark;
    } catch (error) {
      if (!isCurrent()) return;
      console.error('loadSessionMessages failed:', { sessionId, error });
      deps.showToast('加载会话失败', () => loadSessionMessages(sessionId, {
        participantId: targetParticipantId,
        preserveStream,
      }));
    } finally {
      if (seq === messageLoadSeq) {
        messagesLoading.value = false;
        endScrollRestore();
      }
    }
  };

  /** 仅从服务端拉取并合并 id/seq 到当前列表（不替换整表，避免闪烁） */
  const mergeMessageIdsFromServer = async (sessionId) => {
    if (!sessionId || currentSessionId.value !== sessionId || rootMessages.value.length === 0) return;
    const seq = ++messageMergeSeq;
    try {
      const client = deps.chatSdkClient;
      if (!client) throw new Error('Chat SDK 未初始化');
      const result = await client.listMessages(sessionId);
      if (seq !== messageMergeSeq || currentSessionId.value !== sessionId) return;
      const items = result.data?.items || [];
      if (items.length !== rootMessages.value.length) return;
      for (let i = 0; i < items.length; i++) {
        const m = rootMessages.value[i];
        const it = items[i];
        if (!m || !it) continue;
        if (m.role !== it.role) continue;
        m.id = it.id;
        m.seq = it.seq;
      }
      cacheMessages(sessionId, rootMessages.value, 'root');
    } catch (error) {
      console.warn('刷新消息失败:', error.message);
      return;
    }
  };

  return {
    messageCache,
    messagesLoading,
    cacheMessages,
    deleteMessageCache,
    loadSessionMessages,
    mergeMessageIdsFromServer,
  };
}
