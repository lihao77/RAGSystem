import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { createSession, exportSession, getSession } from '../api/session.js';
import { useDictionariesStore } from '../stores/dictionaries.js';
import { useSessionListStore } from '../stores/session-list.js';
import { useSessionRunStore } from '../stores/session-run.js';

const stripWrappedQuotes = (value) => {
  const text = (value || '').trim();
  if (!text) return '';
  const first = text[0];
  const last = text[text.length - 1];
  if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
    return text.slice(1, -1).trim();
  }
  return text;
};

export const normalizeWorkspaceRootInput = (value) => stripWrappedQuotes(value);

const toEntryAgentOptions = (configs) => Object.values(configs || {})
  .filter(config => config && config.enabled)
  .map(config => ({
    value: config.agent_name,
    label: config.display_name || config.agent_name,
    defaultEntry: Boolean(config.default_entry),
  }));

export const updateListedSessionActivity = (sessionListStore, sessionId, content, timestamp) => {
  if (!sessionId) return null;
  return sessionListStore.updateActivity(sessionId, {
    lastMessage: (content || '').toString(),
    activityAt: timestamp || new Date().toISOString(),
    unreadCount: 0,
  });
};

/**
 * 聊天页的会话入口、历史、创建与导出控制。
 */
export function useChatSessionController(deps) {
  const router = useRouter();
  const dictStore = useDictionariesStore();
  const sessionListStore = useSessionListStore();
  const { currentSessionId, isLoading, messages } = storeToRefs(useSessionRunStore());
  const currentSessionTeam = ref('');
  const teamOptions = ref([]);
  const teamLoading = ref(false);
  const pendingWorkspaceRoot = ref('');
  const pendingEntryAgent = ref('');
  const entryAgentOptions = ref([]);
  const entryAgentLoading = ref(false);
  const isExportingSession = ref(false);
  let entryAgentLoadSeq = 0;
  let routeSyncSeq = 0;

  const getChatSessionPath = (sessionId) => (sessionId
    ? `/chat/${encodeURIComponent(sessionId)}`
    : '/');

  const syncTeamOptions = (result) => {
    const teams = Array.isArray(result?.teams) ? result.teams : [];
    teamOptions.value = teams.map((team) => ({
      value: team.team_name,
      label: team.is_active ? `${team.team_name}（默认）` : team.team_name,
      isActive: Boolean(team.is_active),
    }));
    return result;
  };

  const loadEntryAgentOptions = async (teamName = currentSessionTeam.value) => {
    const team = (teamName || '').trim();
    const seq = ++entryAgentLoadSeq;
    entryAgentLoading.value = true;
    try {
      const configs = team
        ? await dictStore.ensureAgents(false, team)
        : await dictStore.ensureAgents();
      // 竞态守卫：只应用最新一次请求，且 team 仍匹配当前选择
      if (seq !== entryAgentLoadSeq) return;
      if (team !== (currentSessionTeam.value || '').trim()) return;

      const items = toEntryAgentOptions(configs);
      entryAgentOptions.value = items;
      if (pendingEntryAgent.value && !items.some((item) => item.value === pendingEntryAgent.value)) {
        pendingEntryAgent.value = '';
      }
    } catch (error) {
      if (seq !== entryAgentLoadSeq) return;
      console.warn('加载入口 Agent 列表失败:', error);
      entryAgentOptions.value = [];
    } finally {
      if (seq === entryAgentLoadSeq) {
        entryAgentLoading.value = false;
      }
    }
  };

  /**
   * 加载 team 列表与 active team。
   * 仅在「新会话且用户尚未选择 team」时回填默认 active team；
   * 绝不给已有 session 用 active team 冒充 metadata.team。
   */
  const loadActiveTeam = async () => {
    teamLoading.value = true;
    try {
      const result = syncTeamOptions(await dictStore.ensureTeams());
      if (!currentSessionId.value && !currentSessionTeam.value.trim()) {
        currentSessionTeam.value = result?.active_team || '';
      }
    } catch (error) {
      console.warn('加载当前 Team 失败:', error);
    } finally {
      teamLoading.value = false;
    }
  };

  const setPendingTeam = async (teamName) => {
    const next = (teamName || '').trim();
    if (next === currentSessionTeam.value.trim()) return;
    currentSessionTeam.value = next;
    pendingEntryAgent.value = '';
    await loadEntryAgentOptions(next);
  };

  const hydrateSessionContext = async (sessionId, listItem = null, isCurrent = () => true) => {
    const result = await getSession(sessionId);
    if (!isCurrent()) return false;
    const detail = result.data;
    const workspace = detail.workspace || listItem?.workspace || null;
    pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(workspace?.root_path || '');
    pendingEntryAgent.value = detail.metadata?.entry_agent || '';
    currentSessionTeam.value = detail.metadata?.team || '';
    return true;
  };

  /**
   * 消息流只更新列表投影字段，不把执行配置混入列表 DTO。
   */
  const updateRecentSession = (sessionId, content, timestamp) => {
    if (!sessionId) return;
    const normalizedWorkspaceRoot = normalizeWorkspaceRootInput(pendingWorkspaceRoot.value);
    if (currentSessionId.value === sessionId && pendingWorkspaceRoot.value !== normalizedWorkspaceRoot) {
      pendingWorkspaceRoot.value = normalizedWorkspaceRoot;
    }
    updateListedSessionActivity(sessionListStore, sessionId, content, timestamp);
  };

  const exportCurrentSession = async () => {
    const sessionId = currentSessionId.value;
    if (!sessionId) {
      deps.showToast('当前无会话');
      return;
    }
    if (isExportingSession.value) return;

    isExportingSession.value = true;
    try {
      const { blob, headers } = await exportSession(sessionId);
      const contentDisposition = headers?.get?.('content-disposition') || '';
      const match = contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
      const filename = match
        ? decodeURIComponent(match[1].replace(/"/g, '').trim())
        : `session_${sessionId}.json`;

      const url = window.URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      deps.showToast('会话导出成功', 'success');
    } catch (error) {
      deps.showToast(error.message || '导出会话失败');
    } finally {
      isExportingSession.value = false;
    }
  };

  const resetNewSessionSetup = async () => {
    pendingWorkspaceRoot.value = '';
    pendingEntryAgent.value = '';
    currentSessionTeam.value = '';
    entryAgentOptions.value = [];
    await loadActiveTeam();
    await loadEntryAgentOptions(currentSessionTeam.value);
  };

  const syncSessionFromRoute = async (sessionId) => {
    if (sessionId === currentSessionId.value) return;
    const seq = ++routeSyncSeq;
    const isCurrent = () => seq === routeSyncSeq && currentSessionId.value === sessionId;
    if (sessionId && sessionId !== currentSessionId.value) {
      deps.disconnectSessionWS();
      deps.invalidateActiveStream();
      deps.clearExecutionState();
      isLoading.value = false;
      currentSessionId.value = sessionId;
      const matched = sessionListStore.getById(sessionId);
      if (!await hydrateSessionContext(sessionId, matched, isCurrent)) return;
      deps.clearComposerAttachments();
      await deps.loadSessionMessages(sessionId);
      if (!isCurrent()) return;
      await deps.loadSessionFiles(sessionId);
      if (!isCurrent()) return;
      deps.resetSessionEventCursor?.(sessionId);
      deps.connectSessionWS(sessionId);
      // 消息加载完成后独立检查任务状态（不在 loadSessionMessages 内部调用）
      await deps.checkSessionTaskStatus(sessionId);
      return;
    }

   if (!sessionId && currentSessionId.value) {
     deps.disconnectSessionWS();
     deps.invalidateActiveStream();
      deps.clearExecutionState({ resetContextUsage: true });
     isLoading.value = false;
      currentSessionId.value = null;
      deps.sessionFiles.value = [];
      await resetNewSessionSetup();
      if (!isCurrent()) return;
      deps.clearComposerAttachments();
      messages.value = [];
      deps.sessionFilesDrawerVisible.value = false;
      deps.sessionFilesDrawerTarget.value = 'composer';
    }
  };

  const ensureSession = async ({ replaceRoute = false } = {}) => {
    if (currentSessionId.value) {
      deps.connectSessionWS(currentSessionId.value);
      return currentSessionId.value;
    }
    const workspaceRoot = normalizeWorkspaceRootInput(pendingWorkspaceRoot.value);
    pendingWorkspaceRoot.value = workspaceRoot;
    const entryAgent = pendingEntryAgent.value.trim();
    if (!currentSessionTeam.value.trim()) {
      await loadActiveTeam();
    }
    const team = currentSessionTeam.value.trim();
    const metadata = {
      ...(team ? { team } : {}),
      ...(entryAgent ? { entry_agent: entryAgent } : {}),
    };
    const body = workspaceRoot
      ? { workspace: { kind: 'local_path', root_path: workspaceRoot } }
      : {};
    if (Object.keys(metadata).length > 0) {
      body.metadata = metadata;
    }
    const result = await createSession(body);
    const sessionId = result.data?.session_id || null;
    if (sessionId) {
      const now = new Date().toISOString();
      // 服务端返回优先，本地选择作兜底
      const sessionMetadata = {
        ...(team ? { team } : {}),
        ...(entryAgent ? { entry_agent: entryAgent } : {}),
        ...(result.data?.metadata || {}),
      };
      const createdListItem = {
        session_id: sessionId,
        title: '新会话',
        first_message: '',
        last_message: '',
        activity_at: now,
        unread_count: 0,
        origin: result.data.origin,
        workspace: result.data.workspace,
      };
      sessionListStore.upsert(createdListItem);
      sessionListStore.syncCreatedSessionFacets(createdListItem);
      void sessionListStore.loadFacets().catch(() => undefined);
      pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(result.data.workspace?.root_path || workspaceRoot);
      pendingEntryAgent.value = sessionMetadata.entry_agent || '';
      currentSessionTeam.value = sessionMetadata.team || '';
      if (currentSessionId.value !== sessionId) {
        currentSessionId.value = sessionId;
      }
      const navigate = replaceRoute ? router.replace : router.push;
      await navigate(getChatSessionPath(sessionId));
      deps.connectSessionWS(sessionId);
      await deps.loadSessionFiles(sessionId);
    }
    return currentSessionId.value;
  };

  return {
    currentSessionTeam,
    teamOptions,
    teamLoading,
    pendingWorkspaceRoot,
    pendingEntryAgent,
    entryAgentOptions,
    entryAgentLoading,
    isExportingSession,
    normalizeWorkspaceRootInput,
    loadEntryAgentOptions,
    loadActiveTeam,
    setPendingTeam,
    exportCurrentSession,
    updateRecentSession,
    syncSessionFromRoute,
    ensureSession,
  };
}
