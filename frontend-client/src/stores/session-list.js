import { ref } from 'vue';
import { defineStore } from 'pinia';
import { listSessions } from '../api/session.js';

/**
 * 会话列表单一真相源。
 * 替代 MainLayout history 与 useChatSessionController sessionHistory 两份副本 + 回调链同步。
 * load() 分页拉取并防重入；upsert() 收归创建/更新置顶逻辑（含 title/first_message 空值保留与 metadata 合并）；
 * remove() 删除。所有消费方（侧栏、命令面板、controller 回填）读同一份 items。
 */
export const useSessionListStore = defineStore('session-list', () => {
  const items = ref([]);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref('');
  const offset = ref(0);
  const hasMore = ref(true);

  const load = async ({ reset = false } = {}) => {
    if (loading.value || loadingMore.value) return;
    if (!hasMore.value && !reset) return;
    if (reset) {
      offset.value = 0;
      hasMore.value = true;
    }
    if (reset) {
      loading.value = true;
    } else {
      loadingMore.value = true;
    }
    error.value = '';
    try {
      const result = await listSessions({ limit: 20, offset: offset.value });
      const payload = result.data || {};
      const fetched = payload.items || [];
      items.value = reset ? fetched : items.value.concat(fetched);
      offset.value += fetched.length;
      hasMore.value = payload.has_more ?? fetched.length >= 20;
    } catch (err) {
      error.value = '加载失败，请重试';
      throw err;
    } finally {
      loading.value = false;
      loadingMore.value = false;
    }
  };

  /**
   * 通用 upsert：接收完整 item。
   * 已存在：合并字段 + 合并 metadata；title/first_message 传入为空则保留旧值；提到顶部（已在顶部则不重排）。
   * 不存在：unshift。同步 offset 以避免分页重复拉取。
   */
  const upsert = (item) => {
    if (!item?.session_id) return null;
    const incoming = { unread_count: 0, ...item };
    const idx = items.value.findIndex(entry => entry.session_id === incoming.session_id);
    if (idx >= 0) {
      const existing = items.value[idx];
      Object.assign(existing, incoming, {
        title: incoming.title || existing.title || '',
        first_message: existing.first_message || incoming.first_message || '',
        metadata: { ...(existing.metadata || {}), ...(incoming.metadata || {}) },
      });
      if (idx === 0) {
        offset.value = items.value.length;
        return existing;
      }
      items.value.splice(idx, 1);
      items.value.unshift(existing);
      offset.value = items.value.length;
      return existing;
    }
    items.value.unshift(incoming);
    offset.value = items.value.length;
    return incoming;
  };

  const remove = (sessionId) => {
    items.value = items.value.filter(item => item.session_id !== sessionId);
  };

  const getById = (sessionId) => (sessionId
    ? items.value.find(item => item.session_id === sessionId) || null
    : null);

  return {
    items,
    loading,
    loadingMore,
    error,
    offset,
    hasMore,
    load,
    upsert,
    remove,
    getById,
  };
});
