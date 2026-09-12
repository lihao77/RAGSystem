import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

const STORAGE_KEY = 'ragsystem:current-workspace';
const VIEW_STORAGE_KEY = 'ragsystem:session-browser-view';
const ORDER_STORAGE_KEY = 'ragsystem:workspace-order';
const COLLAPSED_STORAGE_KEY = 'ragsystem:workspace-collapsed';
export const UNASSIGNED_WORKSPACE_ID = '__unassigned__';
export const SESSION_BROWSER_VIEWS = Object.freeze({ PROJECT: 'project', TIMELINE: 'timeline' });

function byDisplayName(a, b) {
  return String(a.display_name).localeCompare(String(b.display_name));
}

export const useWorkspaceStore = defineStore('workspace', () => {
  const items = ref([]);
  const currentWorkspaceId = ref(null);
  const browserView = ref(SESSION_BROWSER_VIEWS.PROJECT);
  const loading = ref(false);
  const creating = ref(false);
  const removingWorkspaceId = ref(null);
  const error = ref('');
  const collapsedIds = ref([]);
  let client = null;

  const currentWorkspace = computed(() => items.value.find(item => item.workspace_id === currentWorkspaceId.value) || null);

  function setClient(nextClient) { client = nextClient || null; }
  function initializeView() {
    try {
      browserView.value = localStorage.getItem(VIEW_STORAGE_KEY) === SESSION_BROWSER_VIEWS.TIMELINE
        ? SESSION_BROWSER_VIEWS.TIMELINE
        : SESSION_BROWSER_VIEWS.PROJECT;
    } catch { browserView.value = SESSION_BROWSER_VIEWS.PROJECT; }
  }
  function selectView(view) {
    browserView.value = view === SESSION_BROWSER_VIEWS.TIMELINE
      ? SESSION_BROWSER_VIEWS.TIMELINE
      : SESSION_BROWSER_VIEWS.PROJECT;
    try { localStorage.setItem(VIEW_STORAGE_KEY, browserView.value); } catch { /* storage may be unavailable */ }
    return browserView.value;
  }
  function readStoredId() {
    try { return localStorage.getItem(STORAGE_KEY) || null; } catch { return null; }
  }
  function persistId(id) {
    try {
      if (id) localStorage.setItem(STORAGE_KEY, id);
      else localStorage.removeItem(STORAGE_KEY);
    } catch { /* storage may be unavailable */ }
  }
  function readStoredOrder() {
    try {
      const parsed = JSON.parse(localStorage.getItem(ORDER_STORAGE_KEY) || 'null');
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : null;
    } catch { return null; }
  }
  function hasCustomOrder() {
    return Boolean(readStoredOrder()?.length);
  }
  /** 应用自定义顺序；未设置顺序的项目保持服务端顺序排在末尾。 */
  function applyStoredOrder(list) {
    const order = readStoredOrder();
    if (!order?.length) return list;
    const rank = new Map(order.map((id, index) => [id, index]));
    return [...list].sort((a, b) => (rank.get(a.workspace_id) ?? order.length) - (rank.get(b.workspace_id) ?? order.length));
  }
  function persistOrder(ids = items.value.map(item => item.workspace_id)) {
    try { localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(ids)); } catch { /* storage may be unavailable */ }
  }
  function readStoredCollapsed() {
    try {
      const parsed = JSON.parse(localStorage.getItem(COLLAPSED_STORAGE_KEY) || 'null');
      return Array.isArray(parsed) ? parsed.filter(id => typeof id === 'string') : [];
    } catch { return []; }
  }
  function persistCollapsed() {
    try { localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(collapsedIds.value)); } catch { /* storage may be unavailable */ }
  }
  function isCollapsed(id) {
    return collapsedIds.value.includes(id);
  }
  function toggleCollapsed(id) {
    collapsedIds.value = isCollapsed(id)
      ? collapsedIds.value.filter(item => item !== id)
      : [...collapsedIds.value, id];
    persistCollapsed();
  }
  /** 拖拽排序：按给定 id 顺序重排（缺失的项目保持原相对顺序排在末尾）并持久化。 */
  function reorder(orderedIds) {
    const next = [];
    const seen = new Set();
    for (const id of orderedIds || []) {
      const item = items.value.find(entry => entry.workspace_id === id);
      if (item && !seen.has(id)) {
        next.push(item);
        seen.add(id);
      }
    }
    for (const item of items.value) {
      if (!seen.has(item.workspace_id)) next.push(item);
    }
    items.value = next;
    persistOrder();
    return items.value;
  }
  function select(id) {
    const next = id === UNASSIGNED_WORKSPACE_ID || (id && items.value.some(item => item.workspace_id === id)) ? id : UNASSIGNED_WORKSPACE_ID;
    currentWorkspaceId.value = next;
    persistId(next);
    return currentWorkspace.value;
  }
  async function load() {
    if (!client) throw new Error('Chat SDK 未初始化');
    loading.value = true;
    error.value = '';
    try {
      const result = await client.listWorkspaces();
      items.value = applyStoredOrder(Array.isArray(result.data?.items) ? result.data.items : []);
      const stored = readStoredId();
      // “未归属”是合法的持久化选择（不指定项目），不要在刷新后强制回到第一个项目
      const next = stored === UNASSIGNED_WORKSPACE_ID || (stored && items.value.some(item => item.workspace_id === stored))
        ? stored
        : items.value[0]?.workspace_id || UNASSIGNED_WORKSPACE_ID;
      select(next);
      return items.value;
    } catch (cause) {
      error.value = cause?.message || '项目加载失败';
      throw cause;
    } finally {
      loading.value = false;
    }
  }
  async function create(rootPath) {
    const normalized = String(rootPath || '').trim();
    if (!normalized) throw new Error('请输入项目文件夹路径');
    if (!client) throw new Error('Chat SDK 未初始化');
    creating.value = true;
    error.value = '';
    try {
      const result = await client.createWorkspace(normalized);
      const workspace = { ...result.data, session_count: 0 };
      const existing = items.value.findIndex(item => item.workspace_id === workspace.workspace_id);
      if (existing >= 0) items.value.splice(existing, 1, { ...items.value[existing], ...workspace });
      else items.value.push(workspace);
      // 自定义顺序下新项目追加到末尾；默认（未拖拽过）按名称排序
      if (hasCustomOrder()) persistOrder();
      else items.value.sort(byDisplayName);
      select(workspace.workspace_id);
      return workspace;
    } catch (cause) {
      error.value = cause?.message || '项目创建失败';
      throw cause;
    } finally {
      creating.value = false;
    }
  }
  async function remove(workspaceId) {
    const id = String(workspaceId || '').trim();
    if (!id) throw new Error('项目 ID 不能为空');
    if (!client) throw new Error('Chat SDK 未初始化');
    removingWorkspaceId.value = id;
    error.value = '';
    try {
      await client.removeWorkspace(id);
      const index = items.value.findIndex(item => item.workspace_id === id);
      if (index >= 0) items.value.splice(index, 1);
      // 顺手清理排序/折叠存储里已移除项目的 id，避免缓慢累积
      const order = readStoredOrder();
      if (order?.includes(id)) persistOrder(order.filter(storedId => storedId !== id));
      if (collapsedIds.value.includes(id)) {
        collapsedIds.value = collapsedIds.value.filter(storedId => storedId !== id);
        persistCollapsed();
      }
      if (currentWorkspaceId.value === id) {
        select(items.value[0]?.workspace_id || UNASSIGNED_WORKSPACE_ID);
      }
      return true;
    } catch (cause) {
      error.value = cause?.message || '项目移除失败';
      throw cause;
    } finally {
      removingWorkspaceId.value = null;
    }
  }
  async function rename(workspaceId, displayName) {
    const id = String(workspaceId || '').trim();
    const name = String(displayName || '').trim();
    if (!id) throw new Error('项目 ID 不能为空');
    if (!name) throw new Error('项目名称不能为空');
    if (!client) throw new Error('Chat SDK 未初始化');
    error.value = '';
    try {
      const result = await client.updateWorkspace(id, name);
      const workspace = result.data;
      const index = items.value.findIndex(item => item.workspace_id === id);
      if (index >= 0 && workspace) {
        // session_count 不在重命名响应里，保留本地已有值
        items.value.splice(index, 1, { ...items.value[index], ...workspace, session_count: items.value[index].session_count ?? 0 });
        // 自定义顺序下保持位置不变；默认顺序按名称重排
        if (!hasCustomOrder()) items.value.sort(byDisplayName);
      }
      return workspace;
    } catch (cause) {
      error.value = cause?.message || '项目重命名失败';
      throw cause;
    }
  }
  function clear() {
    items.value = [];
    // 清理运行时引用时保留已持久化的项目选择，下一次布局挂载后
    // load() 会根据 localStorage 恢复当前项目。不要在卸载时写入
    // “未归属”，否则刷新/切页会丢失用户最后选择的项目。
    currentWorkspaceId.value = null;
  }
  collapsedIds.value = readStoredCollapsed();
  initializeView();
  return {
    items, currentWorkspaceId, currentWorkspace, browserView, loading, creating, removingWorkspaceId, error,
    collapsedIds, isCollapsed, toggleCollapsed, reorder,
    setClient, load, create, remove, rename, select, selectView, clear,
  };
});
