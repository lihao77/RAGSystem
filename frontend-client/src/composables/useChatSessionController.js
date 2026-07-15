import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { createSession, exportSession } from '../api/session.js';
import { useUserStore } from '../stores/user.js';
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

/**
 * 聊天页的会话入口、历史、创建与导出控制。
 */
export function useChatSessionController(deps) {
  const router = useRouter();
  const dictStore = useDictionariesStore();
  const sessionListStore = useSessionListStore();
  const { currentSessionId, isLoading, messages } = storeToRefs(useSessionRunStore());
  const currentSessionTeam = ref('');
  const pendingWorkspaceRoot = ref('');
  const pendingEntryAgent = ref('');
  const entryAgentOptions = ref([]);
  const entryAgentLoading = ref(false);
  const isExportingSession = ref(false);

  const getChatSessionPath = (sessionId) => (sessionId
    ? `/chat/${encodeURIComponent(sessionId)}`
    : '/');

  const loadEntryAgentOptions = async () => {
    entryAgentLoading.value = true;
    try {
      const configs = await dictStore.ensureAgents();
      const items = Object.values(configs || {})
        .filter(config => config && config.enabled)
        .map(config => ({
          value: config.agent_name,
          label: config.display_name || config.agent_name,
          defaultEntry: Boolean(config.default_entry),
        }));
      entryAgentOptions.value = items;
    } catch (error) {
      console.warn('加载入口 Agent 列表失败:', error);
      entryAgentOptions.value = [];
    } finally {
      entryAgentLoading.value = false;
    }
  };

  const loadActiveTeam = async () => {
    try {
      const result = await dictStore.ensureTeams();
      currentSessionTeam.value = result?.active_team || '';
    } catch (error) {
      console.warn('加载当前 Team 失败:', error);
    }
  };

  const loadRecentSessions = async (reset = false) => {
    try {
      await sessionListStore.load({ reset });
    } catch (error) {
      deps.showToast('加载历史列表失败', retryLoadHistory);
    }
    if (reset && currentSessionId.value) {
      const matched = sessionListStore.getById(currentSessionId.value);
      if (matched) {
        pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(matched.metadata?.workspace_root || pendingWorkspaceRoot.value);
        pendingEntryAgent.value = matched.metadata?.entry_agent || pendingEntryAgent.value;
        currentSessionTeam.value = matched.metadata?.team || currentSessionTeam.value;
      }
    }
  };

  const retryLoadHistory = () => {
    loadRecentSessions(true);
  };

  const updateRecentSession = (sessionId, content, timestamp) => {
    if (!sessionId) return;
    const time = timestamp || new Date().toISOString();
    const normalizedContent = (content || '').toString();
    const summary = normalizedContent.slice(0, 30);
    const normalizedWorkspaceRoot = normalizeWorkspaceRootInput(pendingWorkspaceRoot.value);
    if (currentSessionId.value === sessionId && pendingWorkspaceRoot.value !== normalizedWorkspaceRoot) {
      pendingWorkspaceRoot.value = normalizedWorkspaceRoot;
    }
    const currentMetadata = currentSessionId.value === sessionId
      ? {
          ...(currentSessionTeam.value.trim() ? { team: currentSessionTeam.value.trim() } : {}),
          ...(normalizedWorkspaceRoot ? { workspace_root: normalizedWorkspaceRoot } : {}),
          ...(pendingEntryAgent.value.trim() ? { entry_agent: pendingEntryAgent.value.trim() } : {}),
        }
      : {};
    sessionListStore.upsert({
      session_id: sessionId,
      title: summary,
      first_message: summary,
      last_message: normalizedContent,
      last_message_at: time,
      unread_count: 0,
      metadata: currentMetadata,
    });
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

  const syncSessionFromRoute = async (sessionId) => {
    if (sessionId && sessionId !== currentSessionId.value) {
      deps.disconnectSessionWS();
      deps.invalidateActiveStream();
      deps.clearExecutionState();
      isLoading.value = false;
      currentSessionId.value = sessionId;
      const matched = sessionListStore.getById(sessionId);
      pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(matched?.metadata?.workspace_root || '');
      pendingEntryAgent.value = matched?.metadata?.entry_agent || '';
      currentSessionTeam.value = matched?.metadata?.team || '';
      deps.clearComposerAttachments();
      await deps.loadSessionMessages(sessionId);
      await deps.loadSessionFiles(sessionId);
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
      pendingWorkspaceRoot.value = '';
      pendingEntryAgent.value = '';
      loadActiveTeam();
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
    const userId = useUserStore().userId.value;
    const workspaceRoot = normalizeWorkspaceRootInput(pendingWorkspaceRoot.value);
    pendingWorkspaceRoot.value = workspaceRoot;
    const entryAgent = pendingEntryAgent.value.trim();
    if (!currentSessionTeam.value.trim()) {
      await loadActiveTeam();
    }
    const team = currentSessionTeam.value.trim();
    const metadata = {
      ...(team ? { team } : {}),
      ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
      ...(entryAgent ? { entry_agent: entryAgent } : {}),
    };
    const body = {};
    if (userId) {
      body.user_id = userId;
    }
    if (Object.keys(metadata).length > 0) {
      body.metadata = metadata;
    }
    const result = await createSession(body);
    const sessionId = result.data?.session_id || null;
    if (sessionId) {
      const now = new Date().toISOString();
      const sessionMetadata = {
        ...(team ? { team } : {}),
        ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
        ...(entryAgent ? { entry_agent: entryAgent } : {}),
        ...(result.data?.metadata || {}),
      };
      sessionListStore.upsert({
        session_id: sessionId,
        user_id: result.data?.user_id || null,
        permission_mode: result.data?.permission_mode || null,
        title: result.data?.title || 'New Conversation',
        first_message: '',
        last_message: '',
        last_message_at: result.data?.last_message_at || now,
        unread_count: 0,
        metadata: sessionMetadata,
      });
      pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(sessionMetadata.workspace_root || '');
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
    pendingWorkspaceRoot,
    pendingEntryAgent,
    entryAgentOptions,
    entryAgentLoading,
    isExportingSession,
    normalizeWorkspaceRootInput,
    loadEntryAgentOptions,
    loadActiveTeam,
    loadRecentSessions,
    exportCurrentSession,
    updateRecentSession,
    syncSessionFromRoute,
    ensureSession,
  };
}
