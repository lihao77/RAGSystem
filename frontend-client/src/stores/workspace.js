import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

const STORAGE_KEY = 'ragsystem:current-workspace';
const VIEW_STORAGE_KEY = 'ragsystem:session-browser-view';
export const UNASSIGNED_WORKSPACE_ID = '__unassigned__';
export const SESSION_BROWSER_VIEWS = Object.freeze({ PROJECT: 'project', TIMELINE: 'timeline' });

export const useWorkspaceStore = defineStore('workspace', () => {
  const items = ref([]);
  const currentWorkspaceId = ref(null);
  const browserView = ref(SESSION_BROWSER_VIEWS.PROJECT);
  const loading = ref(false);
  const creating = ref(false);
  const error = ref('');
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
      items.value = Array.isArray(result.data?.items) ? result.data.items : [];
      const stored = readStoredId();
      const next = stored && items.value.some(item => item.workspace_id === stored)
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
      items.value.sort((a, b) => String(a.display_name).localeCompare(String(b.display_name)));
      select(workspace.workspace_id);
      return workspace;
    } catch (cause) {
      error.value = cause?.message || '项目创建失败';
      throw cause;
    } finally {
      creating.value = false;
    }
  }
  function clear() {
    items.value = [];
    // 清理运行时引用时保留已持久化的项目选择，下一次布局挂载后
    // load() 会根据 localStorage 恢复当前项目。不要在卸载时写入
    // “未归属”，否则刷新/切页会丢失用户最后选择的项目。
    currentWorkspaceId.value = null;
  }
  initializeView();
  return {
    items, currentWorkspaceId, currentWorkspace, browserView, loading, creating, error,
    setClient, load, create, select, selectView, clear,
  };
});
