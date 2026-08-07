import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { UNASSIGNED_WORKSPACE_ID } from './workspace.js';

const PAGE_SIZE = 20;
const EMPTY_FACETS = Object.freeze({
  type_counts: { direct: 0, bot: 0, widget: 0 },
  origins: [],
  workspaces: [],
});

export const createEmptySessionListFilters = () => ({
  originType: null,
  originId: null,
  workspaceId: null,
});

function compareSessions(left, right) {
  const leftTime = Date.parse(left?.activity_at || '') || 0;
  const rightTime = Date.parse(right?.activity_at || '') || 0;
  if (leftTime !== rightTime) return rightTime - leftTime;
  return String(right?.session_id || '').localeCompare(String(left?.session_id || ''));
}

function dedupeAndSort(items) {
  const byId = new Map();
  for (const item of items || []) {
    if (item?.session_id) byId.set(item.session_id, item);
  }
  return Array.from(byId.values()).sort(compareSessions);
}

function matchesFilters(item, filters) {
  if (!item?.origin) return false;
  if (filters.originType && item.origin.type !== filters.originType) return false;
  if (filters.originId && item.origin.id !== filters.originId) return false;
  if (filters.workspaceId && item.workspace?.workspace_id !== filters.workspaceId) return false;
  return true;
}

function normalizeFilters(next) {
  const originType = next?.originType || null;
  return {
    originType,
    originId: originType === 'bot' || originType === 'widget' ? next?.originId || null : null,
    workspaceId: next?.workspaceId || null,
  };
}

function sameFilters(left, right) {
  return left.originType === right.originType
    && left.originId === right.originId
    && left.workspaceId === right.workspaceId;
}

/** Cursor-based session list and full facet source used by every list consumer. */
export const useSessionListStore = defineStore('session-list', () => {
  const items = ref([]);
  const nextCursor = ref(null);
  const filters = ref(createEmptySessionListFilters());
  const facets = ref(EMPTY_FACETS);
  const loadingInitial = ref(false);
  const loadingMore = ref(false);
  const loadingFacets = ref(false);
  const error = ref('');
  let listController = null;
  let facetsController = null;
  let listRequestVersion = 0;
  let facetsRequestVersion = 0;
  let localMutationVersion = 0;
  const localMutations = new Map();
  const optimisticFacetSessionIds = new Set();
  let chatSdkClient = null;

  const setChatSdkClient = (client) => {
    chatSdkClient = client || null;
  };

  const hasMore = computed(() => nextCursor.value !== null);

  const cancelListRequest = () => {
    listController?.abort();
    listController = null;
  };

  const recordLocalMutation = (sessionId, kind, item = null) => {
    const version = ++localMutationVersion;
    localMutations.set(sessionId, { version, kind, item });
  };

  const applyLocalMutations = (baseItems, afterVersion) => {
    const merged = new Map(dedupeAndSort(baseItems).map(item => [item.session_id, item]));
    for (const [sessionId, mutation] of localMutations) {
      if (mutation.version <= afterVersion) continue;
      merged.delete(sessionId);
      if (
        mutation.kind === 'upsert'
        && mutation.item?.origin
        && mutation.item?.activity_at
        && matchesFilters(mutation.item, filters.value)
      ) {
        merged.set(sessionId, mutation.item);
      }
    }
    return Array.from(merged.values()).sort(compareSessions);
  };

  const pruneLocalMutations = (throughVersion) => {
    for (const [sessionId, mutation] of localMutations) {
      if (mutation.version <= throughVersion) localMutations.delete(sessionId);
    }
  };

  const load = async ({ reset = false } = {}) => {
    if (!reset && (loadingInitial.value || loadingMore.value || !hasMore.value)) return;
    if (reset) {
      cancelListRequest();
      items.value = items.value.filter(item => matchesFilters(item, filters.value));
      nextCursor.value = null;
      loadingInitial.value = false;
      loadingMore.value = false;
    }

    const version = ++listRequestVersion;
    const mutationVersionAtStart = localMutationVersion;
    const controller = new AbortController();
    listController = controller;
    if (reset) loadingInitial.value = true;
    else loadingMore.value = true;
    error.value = '';

    try {
      const listOptions = {
        limit: PAGE_SIZE,
        cursor: reset ? null : nextCursor.value,
        originType: filters.value.originType,
        originId: filters.value.originId,
        workspaceId: filters.value.workspaceId,
        signal: controller.signal,
      };
      if (!chatSdkClient) throw new Error('Chat SDK 未初始化');
      const result = await chatSdkClient.listSessions(listOptions);
      if (version !== listRequestVersion) return;
      const page = result.data;
      items.value = applyLocalMutations(
        reset ? page.items : [...items.value, ...page.items],
        mutationVersionAtStart,
      );
      pruneLocalMutations(mutationVersionAtStart);
      nextCursor.value = page.next_cursor;
    } catch (err) {
      if (controller.signal.aborted || version !== listRequestVersion) return;
      error.value = '加载失败，请重试';
      throw err;
    } finally {
      if (version === listRequestVersion) {
        loadingInitial.value = false;
        loadingMore.value = false;
        listController = null;
      }
    }
  };

  const reconcileFilters = (nextFacets) => {
    const next = { ...filters.value };
    if (next.originId && !nextFacets.origins.some(origin => (
      origin.type === next.originType && origin.id === next.originId
    ))) {
      next.originId = null;
    }
    if (
      next.workspaceId
      && next.workspaceId !== UNASSIGNED_WORKSPACE_ID
      && !nextFacets.workspaces.some(workspace => workspace.workspace_id === next.workspaceId)
    ) {
      next.workspaceId = null;
    }
    if (sameFilters(filters.value, next)) return false;
    filters.value = next;
    return true;
  };

  const loadFacets = async () => {
    facetsController?.abort();
    const version = ++facetsRequestVersion;
    const controller = new AbortController();
    facetsController = controller;
    loadingFacets.value = true;
    try {
      if (!chatSdkClient) throw new Error('Chat SDK 未初始化');
      const result = await chatSdkClient.getSessionFacets({ signal: controller.signal });
      if (version !== facetsRequestVersion) return;
      facets.value = result.data;
      optimisticFacetSessionIds.clear();
      if (reconcileFilters(result.data)) {
        await load({ reset: true });
      }
    } catch (err) {
      if (controller.signal.aborted || version !== facetsRequestVersion) return;
      throw err;
    } finally {
      if (version === facetsRequestVersion) {
        loadingFacets.value = false;
        facetsController = null;
      }
    }
  };

  const initialize = async () => {
    const results = await Promise.allSettled([
      load({ reset: true }),
      loadFacets(),
    ]);
    const rejected = results.find(result => result.status === 'rejected');
    if (rejected) throw rejected.reason;
  };

  const setFilters = async (next) => {
    const normalized = normalizeFilters({ ...filters.value, ...next });
    if (sameFilters(filters.value, normalized)) return;
    filters.value = normalized;
    await load({ reset: true });
  };

  const clearFilters = () => setFilters(createEmptySessionListFilters());

  const syncCreatedSessionFacets = (item) => {
    if (!item?.session_id || !item.origin?.type || optimisticFacetSessionIds.has(item.session_id)) return;
    optimisticFacetSessionIds.add(item.session_id);

    const typeCounts = {
      ...facets.value.type_counts,
      [item.origin.type]: (facets.value.type_counts[item.origin.type] || 0) + 1,
    };
    const origins = facets.value.origins.map(origin => ({ ...origin }));
    if ((item.origin.type === 'bot' || item.origin.type === 'widget') && item.origin.id) {
      const origin = origins.find(entry => entry.type === item.origin.type && entry.id === item.origin.id);
      if (origin) origin.count += 1;
      else {
        origins.push({
          type: item.origin.type,
          id: item.origin.id,
          display_name: item.origin.display_name,
          count: 1,
        });
      }
    }

    const workspaces = facets.value.workspaces.map(workspace => ({ ...workspace }));
    if (item.workspace?.workspace_id) {
      const workspace = workspaces.find(entry => entry.workspace_id === item.workspace.workspace_id);
      if (workspace) workspace.count += 1;
      else workspaces.push({ ...item.workspace, count: 1 });
    }

    facets.value = { type_counts: typeCounts, origins, workspaces };
  };

  const upsert = (item) => {
    if (!item?.session_id) return null;
    const index = items.value.findIndex(entry => entry.session_id === item.session_id);
    const existing = index >= 0 ? items.value[index] : null;
    const merged = existing ? { ...existing, ...item } : item;

    if (!matchesFilters(merged, filters.value)) {
      if (existing) items.value.splice(index, 1);
      recordLocalMutation(item.session_id, 'remove');
      return null;
    }
    if (!existing && (!merged.origin || !merged.activity_at)) return null;

    if (existing) items.value.splice(index, 1, merged);
    else items.value.push(merged);
    items.value.sort(compareSessions);
    recordLocalMutation(item.session_id, 'upsert', merged);
    return merged;
  };

  const updateActivity = (sessionId, { lastMessage, activityAt, unreadCount } = {}) => {
    const index = items.value.findIndex(item => item.session_id === sessionId);
    if (index < 0) return null;

    const existing = items.value[index];
    const updated = {
      ...existing,
      last_message: lastMessage === undefined ? existing.last_message : String(lastMessage),
      activity_at: activityAt || existing.activity_at,
      ...(unreadCount === undefined ? {} : { unread_count: unreadCount }),
    };
    items.value.splice(index, 1, updated);
    items.value.sort(compareSessions);
    recordLocalMutation(sessionId, 'upsert', updated);
    return updated;
  };

  const remove = (sessionId) => {
    items.value = items.value.filter(item => item.session_id !== sessionId);
    recordLocalMutation(sessionId, 'remove');
  };

  const getById = sessionId => (sessionId
    ? items.value.find(item => item.session_id === sessionId) || null
    : null);

  const dispose = () => {
    cancelListRequest();
    facetsController?.abort();
  };

  return {
    items,
    nextCursor,
    filters,
    facets,
    loadingInitial,
    loadingMore,
    loadingFacets,
    error,
    hasMore,
    initialize,
    load,
    loadFacets,
    setFilters,
    clearFilters,
    syncCreatedSessionFacets,
    upsert,
    updateActivity,
    remove,
    getById,
    dispose,
    setChatSdkClient,
  };
});
