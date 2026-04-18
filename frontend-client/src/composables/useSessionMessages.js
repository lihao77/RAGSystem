import { ref, nextTick } from 'vue';

/**
 * 会话消息加载、缓存、合并。
 *
 * @param {Object} deps
 * @param {import('vue').Ref} deps.currentSessionId
 * @param {import('vue').Ref} deps.messages
 * @param {Function} deps.normalizeAssistantExecutionState
 * @param {Function} deps.createAssistantMessageFromHistory
 * @param {Function} deps.normalizeAttachment
 * @param {Function} deps.scrollToBottom
 * @param {Function} deps.waitForScrollLayout
 * @param {Function} deps.focusInput
 * @param {Function} deps.loadContextSnapshot
 * @param {Function} deps.showToast
 * @param {Function} deps.invalidateActiveStream
 */
export function useSessionMessages(deps) {
  const messageCache = ref(new Map());
  const messagesLoading = ref(false);
  const maxCachedSessions = 10;

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

  const loadSessionMessages = async (sessionId, { silent = false } = {}) => {
    if (!sessionId) return;
    if (!silent) {
      deps.invalidateActiveStream();
      messagesLoading.value = true;
    }
    try {
      // 非静默加载（路由切换/手动刷新）始终绕过缓存，确保拿到最新数据
      const cached = silent ? messageCache.value.get(sessionId) : null;
      if (cached) {
        deps.messages.value = cached.map(item => deps.normalizeAssistantExecutionState(item));
        messagesLoading.value = false;
        await nextTick();
        await deps.scrollToBottom(true);
        await deps.waitForScrollLayout();
        await deps.scrollToBottom(true);
        deps.focusInput();
        return;
      }
      const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&offset=0&expand=none`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const result = await response.json();
      const items = result.data?.items || [];
      const mapped = items
        .filter(item => {
          const meta = item.metadata || {};
          if (meta.visible_to_user === false && !meta.display_only) return false;
          if (meta.hidden) return false;
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
          const attachments = Array.isArray(item.metadata?.attachments)
            ? item.metadata.attachments.map(deps.normalizeAttachment).filter(Boolean)
            : [];
          return { role: 'user', id: item.id, seq: item.seq, content: item.content || '', metadata: item.metadata || {}, attachments };
        });
      deps.messages.value = mapped;
      cacheMessages(sessionId, mapped);
      messagesLoading.value = false;
      await nextTick();
      await nextTick();
      await deps.scrollToBottom(true);
      await deps.waitForScrollLayout();
      await deps.scrollToBottom(true);
      deps.focusInput();
      if (!silent) await deps.loadContextSnapshot(sessionId);
    } catch (error) {
      console.error('loadSessionMessages failed:', { sessionId, error });
      deps.showToast('加载会话失败', () => loadSessionMessages(sessionId));
    } finally {
      messagesLoading.value = false;
    }
  };

  /** 仅从服务端拉取并合并 id/seq 到当前列表（不替换整表，避免闪烁） */
  const mergeMessageIdsFromServer = async (sessionId) => {
    if (!sessionId || deps.messages.value.length === 0) return;
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&offset=0&expand=none`);
      if (!res.ok) return;
      const result = await res.json();
      const items = result.data?.items || [];
      if (items.length !== deps.messages.value.length) return;
      for (let i = 0; i < items.length; i++) {
        const m = deps.messages.value[i];
        const it = items[i];
        if (!m || !it) continue;
        if (m.role !== it.role) continue;
        m.id = it.id;
        m.seq = it.seq;
      }
      cacheMessages(sessionId, deps.messages.value);
    } catch (_) {}
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
