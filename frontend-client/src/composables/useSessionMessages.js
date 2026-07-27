import { ref, nextTick } from 'vue';
import { storeToRefs } from 'pinia';
import { getSessionMessages } from '../api/session.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { getMessageAttachments } from '../utils/messageExtensions.js';

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
 * @param {Function} [deps.beginInitialScrollRestore]
 * @param {Function} [deps.endInitialScrollRestore]
 */
export function useSessionMessages(deps) {
  const { currentSessionId, messages } = storeToRefs(useSessionRunStore());
  const messageCache = ref(new Map());
  const messagesLoading = ref(false);
  const maxCachedSessions = 10;
  let messageLoadSeq = 0;
  let messageMergeSeq = 0;

  const cacheMessages = (sessionId, list) => {
    if (!sessionId) return;
    if (messageCache.value.has(sessionId)) {
      messageCache.value.delete(sessionId);
    }
    messageCache.value.set(
      sessionId,
      list.slice(-500).map(item => deps.normalizeAssistantExecutionState(item))
    );
    if (messageCache.value.size > maxCachedSessions) {
      const oldestKey = messageCache.value.keys().next().value;
      messageCache.value.delete(oldestKey);
    }
  };

  const deleteMessageCache = (sessionId) => {
    messageCache.value.delete(sessionId);
  };

  /**
   * 只负责消息列表与缓存，不负责 task-status。
   * 进入/切换会话的调用方需在消息加载后显式调用 checkSessionTaskStatus。
   */
  const loadSessionMessages = async (sessionId, { silent = false } = {}) => {
    if (!sessionId) return;
    const seq = ++messageLoadSeq;
    const isCurrent = () => seq === messageLoadSeq && currentSessionId.value === sessionId;
    let scrollRestoreStarted = false;
    let scrollRestoreEnded = false;
    const endScrollRestore = () => {
      if (!scrollRestoreStarted || scrollRestoreEnded) return;
      deps.endInitialScrollRestore?.();
      scrollRestoreEnded = true;
    };

    if (!silent) {
      deps.invalidateActiveStream();
      deps.beginInitialScrollRestore?.();
      scrollRestoreStarted = true;
      messagesLoading.value = true;
    }
    try {
      // 非静默加载（路由切换/手动刷新）始终绕过缓存，确保拿到最新数据
      const cached = silent ? messageCache.value.get(sessionId) : null;
      if (cached) {
        if (!isCurrent()) return;
        messages.value = cached.map(item => deps.normalizeAssistantExecutionState(item));
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
      const result = await getSessionMessages(sessionId);
      const items = result.data?.items || [];
      const mapped = items
        .filter(item => {
          const meta = item.metadata || {};
          if (meta.visible_to_user === false && !meta.display_only) return false;
          if (meta.hidden) return false;
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
              metadata: item.metadata || {},
            };
          }
          const attachments = getMessageAttachments(item.metadata);
          return { role: 'user', id: item.id, seq: item.seq, content: item.content || '', metadata: item.metadata || {}, attachments };
        });
      if (!isCurrent()) return;
      messages.value = mapped;
      cacheMessages(sessionId, mapped);
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
      if (!silent) await deps.loadContextSnapshot(sessionId);
    } catch (error) {
      if (!isCurrent()) return;
      console.error('loadSessionMessages failed:', { sessionId, error });
      deps.showToast('加载会话失败', () => loadSessionMessages(sessionId));
    } finally {
      if (seq === messageLoadSeq) {
        messagesLoading.value = false;
        endScrollRestore();
      }
    }
  };

  /** 仅从服务端拉取并合并 id/seq 到当前列表（不替换整表，避免闪烁） */
  const mergeMessageIdsFromServer = async (sessionId) => {
    if (!sessionId || currentSessionId.value !== sessionId || messages.value.length === 0) return;
    const seq = ++messageMergeSeq;
    try {
      const result = await getSessionMessages(sessionId);
      if (seq !== messageMergeSeq || currentSessionId.value !== sessionId) return;
      const items = result.data?.items || [];
      if (items.length !== messages.value.length) return;
      for (let i = 0; i < items.length; i++) {
        const m = messages.value[i];
        const it = items[i];
        if (!m || !it) continue;
        if (m.role !== it.role) continue;
        m.id = it.id;
        m.seq = it.seq;
      }
      cacheMessages(sessionId, messages.value);
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
