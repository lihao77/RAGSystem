import { ref, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { getMessageAttachments, normalizeMessageContentParts, partsToPlainText } from '../utils/messageContentParts.js';

const AGENT_MESSAGE_WRAPPER = /^\[agent-message[^\]]*\]\r?\n([\s\S]*?)\r?\n\[\/agent-message\]\s*$/;

export function getAgentMessageDisplayContent(item) {
  const metadataContent = item?.metadata?.agent_message_display_content;
  if (typeof metadataContent === 'string') return metadataContent;
  const content = typeof item?.content === 'string' ? item.content : partsToPlainText(item?.content_parts);
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
  const messageLoadSeqByKey = new Map();
  let messageMergeSeq = 0;

  const cacheKey = (sessionId, participantId = 'root') => `${sessionId}::${participantId || 'root'}`;

  // "正在压缩…"横线（context_compression_pending）是纯客户端瞬态项，不落库。静默权威重载会
  // 整表替换列表：主输入框 /compact 时 message_saved 先结束 pendingCommand，随后 maintenance
  // 心跳触发的 session_updated 静默重载护栏失效，横线刚挂上就被替换抹掉（回滚路径因 maintenance
  // 快照先到、isLoading 护栏跳过重载而幸免）。故静默替换时保留横线；非静默（进入/刷新会话）
  // 不保留——刷新后由运行状态胶囊（maintenance·compact）承担进行时反馈，也避免后端崩溃后
  // 横线永久滞留。终态 command_result 先移除横线再重载，保留只作用于压缩进行中的窗口。
  const preserveCompactPendingDivider = (list, { silent }) => {
    if (!silent || list.some(message => message?.metadata?.msg_type === 'context_compression_pending')) return list;
    const pending = rootMessages.value.find(
      message => message?.metadata?.msg_type === 'context_compression_pending',
    );
    return pending ? [...list, pending] : list;
  };

  const cacheMessages = (sessionId, list, participantId = 'root') => {
    if (!sessionId) return;
    if (participantId === 'root') sessionRunStore.reconcilePendingFollowups(sessionId, list);
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

  const mapHistoryItems = (items) => items
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
          content: partsToPlainText(item.content_parts),
          content_parts: normalizeMessageContentParts(item.content_parts),
          metadata: item.metadata || {},
        };
      }
      const contentParts = normalizeMessageContentParts(item.content_parts);
      const metadata = item.metadata || {};
      const agentMessage = metadata.agent_message === true;
      const content = agentMessage ? getAgentMessageDisplayContent(item) : partsToPlainText(item.content_parts);
      const message = {
        role: 'user',
        id: item.id,
        seq: item.seq,
        thread_key: item.thread_key,
        child_agent_id: item.child_agent_id ?? null,
        content,
        content_parts: agentMessage ? [{ type: 'text', text: content }] : contentParts,
        finished: true,
        has_execution: Boolean(item.has_execution),
        executionTree: { root: null },
        executionStepsLoaded: false,
        executionStepsLoading: false,
        executionStepsLoadError: '',
        run_id: metadata.consumed_by_run_id || metadata.run_id || null,
        _execState: null,
        metadata: agentMessage
          ? { ...metadata, agent_message_display_content: content }
          : metadata,
      };
      return deps.normalizeAssistantExecutionState({
        ...message,
        attachments: getMessageAttachments(message),
      });
    });

  /**
   * 历史与子线程的按需加载；会话恢复入口由 WebSocket session.snapshot 提供。
   * @param {string} sessionId
   * @param {Object} [options]
   * @param {boolean} [options.viewEffects] 子线程传 false，由自己的视图管理滚动。
   */

  const loadSessionMessages = async (sessionId, {
    silent = false,
    participantId = 'root',
    preserveStream = false,
    bypassCache = false,
    viewEffects = true,
    reconcileMode = preserveStream ? 'live' : 'authoritative',
  } = {}) => {
    if (!sessionId) return null;
    const targetParticipantId = participantId || 'root';
    const loadKey = cacheKey(sessionId, targetParticipantId);
    const projectionRevision = sessionRunStore.messageProjectionRevision;
    const seq = (messageLoadSeqByKey.get(loadKey) || 0) + 1;
    messageLoadSeqByKey.set(loadKey, seq);
    // 主对话列永远是根会话，所以根加载只认会话；子参与者加载额外认"工作台还在看它"，
    // 避免用户在加载途中切走页签后，迟到的响应把线程写回一个已经不在看的视图。
    const isCurrent = () => messageLoadSeqByKey.get(loadKey) === seq
      && currentSessionId.value === sessionId
      && (silent || targetParticipantId === 'root' || selectedParticipantId.value === targetParticipantId);
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
      const cached = silent && !bypassCache
        ? messageCache.value.get(cacheKey(sessionId, targetParticipantId))
        : null;
      if (cached) {
        if (!isCurrent()) return;
        const restored = cached.map(item => deps.normalizeAssistantExecutionState(item));
        if (targetParticipantId !== 'root' || preserveStream) {
          sessionRunStore.reconcileParticipantMessages(targetParticipantId, restored, {
            preserveLiveExecution: reconcileMode === 'live',
          });
        } else {
          sessionRunStore.setParticipantMessages(targetParticipantId, preserveCompactPendingDivider(restored, { silent }));
        }
        messagesLoading.value = false;
        await nextTick();
        if (!isCurrent()) return;
        if (viewEffects) {
          await deps.scrollToBottom(true, 'auto');
          if (!isCurrent()) return;
          await deps.waitForScrollLayout();
          if (!isCurrent()) return;
          await deps.scrollToBottom(true, 'auto');
          if (!isCurrent()) return;
        }
        endScrollRestore();
        if (viewEffects) deps.focusInput();
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
      const mapped = mapHistoryItems(items);
      if (!isCurrent()) return;
      if (!preserveStream && projectionRevision !== sessionRunStore.messageProjectionRevision) return;
      const nextMessages = targetParticipantId !== 'root' || preserveStream || reconcileMode === 'live'
        ? sessionRunStore.reconcileParticipantMessages(targetParticipantId, mapped, {
            preserveLiveExecution: reconcileMode === 'live',
          })
        : sessionRunStore.setParticipantMessages(targetParticipantId, preserveCompactPendingDivider(mapped, { silent }));
      cacheMessages(sessionId, nextMessages, targetParticipantId);
      messagesLoading.value = false;
      await nextTick();
      await nextTick();
      if (!isCurrent()) return;
      if (viewEffects) {
        await deps.scrollToBottom(true, 'auto');
        if (!isCurrent()) return;
        await deps.waitForScrollLayout();
        if (!isCurrent()) return;
        await deps.scrollToBottom(true, 'auto');
        if (!isCurrent()) return;
      }
      endScrollRestore();
      if (viewEffects) deps.focusInput();
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
        viewEffects,
        reconcileMode,
      }));
    } finally {
      if (messageLoadSeqByKey.get(loadKey) === seq) {
        messagesLoading.value = false;
        endScrollRestore();
      }
    }
  };

  const applySnapshotMessages = (sessionId, snapshot) => {
    if (sessionId !== currentSessionId.value) return false;
    messageMergeSeq++;
    // Supersede all HTTP work already in flight, including participant histories.
    for (const [key, seq] of messageLoadSeqByKey) {
      if (key.startsWith(`${sessionId}::`)) messageLoadSeqByKey.set(key, seq + 1);
    }
    deleteMessageCache(sessionId);
    const loadedChildren = Object.keys(sessionRunStore.participantMessages).filter(id => id !== 'root');
    for (const id of loadedChildren) sessionRunStore.setParticipantMessages(id, []);
    sessionRunStore.setParticipantMessages('root', mapHistoryItems(snapshot.messages.items));
    sessionRunStore.setParticipants(snapshot.participants);
    messagesLoading.value = false;
    for (const participantId of loadedChildren) {
      void loadSessionMessages(sessionId, { participantId, silent: true, bypassCache: true,
        preserveStream: true, viewEffects: false });
    }
    return true;
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
    applySnapshotMessages,
    mergeMessageIdsFromServer,
  };
}
