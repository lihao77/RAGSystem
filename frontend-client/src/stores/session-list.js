import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { UNASSIGNED_WORKSPACE_ID } from './workspace.js';
import { useSessionPins } from '../composables/useSessionPins.js';

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
  /** 项目视图按工作区独立分页：工作区 id（含 __unassigned__）→ 该工作区自己的下一页游标；null 表示取尽 */
  const workspaceCursors = ref({});
  const loadingWorkspaceIds = ref({});
  /** 项目视图首屏预览每个筛选生命周期只取一次；reset 时随游标一起失效 */
  const previewLoaded = ref(false);
  let listController = null;
  let facetsController = null;
  let previewController = null;
  let listRequestVersion = 0;
  let facetsRequestVersion = 0;
  let localMutationVersion = 0;
  const localMutations = new Map();
  const optimisticFacetSessionIds = new Set();
  const workspaceControllers = new Map();
  let chatSdkClient = null;
  const pins = useSessionPins(items, () => chatSdkClient);
  const pinnedItems = computed(() => pins.items.value.filter(item => matchesFilters(item, filters.value)));
  const unpinnedItems = computed(() => items.value.filter(item => !pins.ids.value.includes(item.session_id)));

  /** 全局页与工作区页按活跃时间各排各的，工作区首页常与已加载项整页重复；连追几页直到出现新会话 */
  const WORKSPACE_CHASE_LIMIT = 4;

  const setChatSdkClient = (client) => {
    chatSdkClient = client || null;
  };

  const hasMore = computed(() => nextCursor.value !== null);

  const workspaceHasMore = (workspaceId) => {
    // 面板工作区筛选激活时，其他组的数据会被 matchesFilters 全部丢弃，按钮不可用
    if (filters.value.workspaceId && filters.value.workspaceId !== workspaceId) return false;
    const cursor = workspaceCursors.value[workspaceId];
    if (cursor === null) return false;
    // facets 的全量计数（无来源筛选时准确）可先一步排除空项目，避免渲染出点了才消失的死按钮
    if (workspaceId !== UNASSIGNED_WORKSPACE_ID && !filters.value.originType && !filters.value.originId) {
      const facet = facets.value.workspaces.find(entry => entry.workspace_id === workspaceId);
      if (facet && facet.count === 0) return false;
    }
    return true;
  };

  const resetWorkspaceCursors = () => {
    for (const controller of workspaceControllers.values()) controller.abort();
    workspaceControllers.clear();
    workspaceCursors.value = {};
    loadingWorkspaceIds.value = {};
    previewController?.abort();
    previewController = null;
    previewLoaded.value = false;
  };

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
      resetWorkspaceCursors();
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

  /**
   * 项目视图按工作区独立翻页：游标只属于该工作区，取回的条目并进共享 items（时间轴视图同样受益）。
   * 与全局翻页互不影响；筛选变更（reset）会使全部工作区游标失效重来。
   */
  const loadWorkspace = async (workspaceId) => {
    if (!workspaceId || loadingWorkspaceIds.value[workspaceId] || !workspaceHasMore(workspaceId)) return;
    if (!chatSdkClient) throw new Error('Chat SDK 未初始化');

    const filtersAtStart = filters.value;
    const controller = new AbortController();
    workspaceControllers.set(workspaceId, controller);
    loadingWorkspaceIds.value = { ...loadingWorkspaceIds.value, [workspaceId]: true };

    try {
      const knownIds = new Set(items.value.map(entry => entry.session_id));
      let cursor = workspaceCursors.value[workspaceId] ?? null;
      for (let attempt = 0; attempt < WORKSPACE_CHASE_LIMIT; attempt += 1) {
        const result = await chatSdkClient.listSessions({
          limit: PAGE_SIZE,
          cursor,
          workspaceId,
          originType: filtersAtStart.originType,
          originId: filtersAtStart.originId,
          signal: controller.signal,
        });
        if (controller.signal.aborted || filters.value !== filtersAtStart) return;
        const page = result.data;
        const merged = page.items.filter(entry => entry?.session_id && matchesFilters(entry, filtersAtStart));
        const fresh = merged.filter(entry => !knownIds.has(entry.session_id));
        items.value = applyLocalMutations([...items.value, ...merged], 0);
        workspaceCursors.value = { ...workspaceCursors.value, [workspaceId]: page.next_cursor };
        if (fresh.length > 0 || page.next_cursor === null) break;
        cursor = page.next_cursor;
      }
    } catch (err) {
      if (controller.signal.aborted || filters.value !== filtersAtStart) return;
      throw err;
    } finally {
      // reset 中止后同组可能已有新请求在途：只清理仍属于自己的登记
      if (workspaceControllers.get(workspaceId) === controller) {
        workspaceControllers.delete(workspaceId);
        loadingWorkspaceIds.value = { ...loadingWorkspaceIds.value, [workspaceId]: false };
      }
    }
  };

  /**
   * 项目视图首屏：一次请求带回每个项目各自的最新一页（含未归属组）和续页游标。
   * 解决全局首页被活跃项目占满时，安静项目在项目视图里一条都轮不上的问题；
   * 回来的游标直接播种 workspaceCursors，组内「加载更多」顺着它续页（不会再与全局页重叠）。
   */
  const loadWorkspacePreview = async () => {
    if (previewLoaded.value) return;
    if (filters.value.workspaceId) return;
    if (!chatSdkClient) throw new Error('Chat SDK 未初始化');
    previewLoaded.value = true;

    const filtersAtStart = filters.value;
    const controller = new AbortController();
    previewController = controller;
    try {
      const result = await chatSdkClient.listSessionWorkspacePreview({
        limit: 5,
        originType: filtersAtStart.originType,
        originId: filtersAtStart.originId,
        signal: controller.signal,
      });
      if (controller.signal.aborted || filters.value !== filtersAtStart) return;
      const merged = [];
      const cursors = {};
      for (const group of result.data.groups) {
        for (const entry of group.items) {
          if (entry?.session_id && matchesFilters(entry, filtersAtStart)) merged.push(entry);
        }
        // 用户可能已在 preview 在途时点过某组「加载更多」推进了游标，不回退到更浅的位置
        if (!(group.workspace_id in workspaceCursors.value)) cursors[group.workspace_id] = group.next_cursor;
      }
      items.value = applyLocalMutations([...items.value, ...merged], 0);
      workspaceCursors.value = { ...workspaceCursors.value, ...cursors };
    } catch (err) {
      if (controller.signal.aborted || filters.value !== filtersAtStart) return;
      previewLoaded.value = false;
      throw err;
    } finally {
      if (previewController === controller) previewController = null;
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
    const existing = index >= 0 ? items.value[index] : pins.getById(item.session_id);
    const merged = existing ? { ...existing, ...item } : item;
    pins.sync([merged]);

    if (!matchesFilters(merged, filters.value)) {
      if (index >= 0) items.value.splice(index, 1);
      recordLocalMutation(item.session_id, 'remove');
      return null;
    }
    if (!existing && (!merged.origin || !merged.activity_at)) return null;

    if (index >= 0) items.value.splice(index, 1, merged);
    else items.value.push(merged);
    items.value.sort(compareSessions);
    recordLocalMutation(item.session_id, 'upsert', merged);
    return merged;
  };

  const updateActivity = (sessionId, { lastMessage, activityAt, unreadCount } = {}) => {
    const index = items.value.findIndex(item => item.session_id === sessionId);
    const existing = index >= 0 ? items.value[index] : pins.getById(sessionId);
    if (!existing) return null;
    const updated = {
      ...existing,
      last_message: lastMessage === undefined ? existing.last_message : String(lastMessage),
      activity_at: activityAt || existing.activity_at,
      ...(unreadCount === undefined ? {} : { unread_count: unreadCount }),
    };
    if (index >= 0) items.value.splice(index, 1, updated);
    pins.sync([updated]);
    items.value.sort(compareSessions);
    recordLocalMutation(sessionId, 'upsert', updated);
    return updated;
  };

  const remove = (sessionId) => {
    pins.unpin(sessionId);
    items.value = items.value.filter(item => item.session_id !== sessionId);
    recordLocalMutation(sessionId, 'remove');
  };

  /** 只改标题（LLM 生成标题回显）；顺序不变，空值/同值跳过。 */
  const updateTitle = (sessionId, title) => {
    const nextTitle = String(title ?? '').trim();
    if (!nextTitle) return null;
    const index = items.value.findIndex(item => item.session_id === sessionId);
    const existing = index >= 0 ? items.value[index] : pins.getById(sessionId);
    if (!existing) return null;
    if (existing.title === nextTitle) return existing;
    const updated = { ...existing, title: nextTitle };
    if (index >= 0) items.value.splice(index, 1, updated);
    pins.sync([updated]);
    recordLocalMutation(sessionId, 'upsert', updated);
    return updated;
  };

  const getById = sessionId => (sessionId
    ? items.value.find(item => item.session_id === sessionId) || pins.getById(sessionId)
    : null);

  const dispose = () => {
    pins.dispose();
    cancelListRequest();
    facetsController?.abort();
    resetWorkspaceCursors();
  };

  return {
    items,
    pinnedItems,
    unpinnedItems,
    togglePin: (item) => {
      if (!pins.toggle(item)) return false;
      // Restored pins may be outside the currently loaded cursor page.
      upsert(item);
      return true;
    },
    loadPins: pins.load,
    nextCursor,
    filters,
    facets,
    loadingInitial,
    loadingMore,
    loadingFacets,
    loadingWorkspaceIds,
    workspaceCursors,
    error,
    hasMore,
    initialize,
    load,
    loadWorkspace,
    loadWorkspacePreview,
    workspaceHasMore,
    loadFacets,
    setFilters,
    clearFilters,
    syncCreatedSessionFacets,
    upsert,
    updateActivity,
    updateTitle,
    remove,
    getById,
    dispose,
    setChatSdkClient,
  };
});
