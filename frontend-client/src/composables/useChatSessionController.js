import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { getAllAgentConfigs, getTeams } from '../api/agentConfig';

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
  const currentSessionTeam = ref('');
  const pendingWorkspaceRoot = ref('');
  const pendingEntryAgent = ref('');
  const entryAgentOptions = ref([]);
  const entryAgentLoading = ref(false);
  const isExportingSession = ref(false);

  const sessionHistory = ref([]);
  const historyLoading = ref(false);
  const historyLoadingMore = ref(false);
  const historyError = ref('');
  const historyOffset = ref(0);
  const historyHasMore = ref(true);

  const getChatSessionPath = (sessionId) => (sessionId
    ? `/chat/${encodeURIComponent(sessionId)}`
    : '/');

  const loadEntryAgentOptions = async () => {
    entryAgentLoading.value = true;
    try {
      const configs = await getAllAgentConfigs();
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
      const result = await getTeams();
      currentSessionTeam.value = result?.active_team || '';
    } catch (error) {
      console.warn('加载当前 Team 失败:', error);
    }
  };

  const loadRecentSessions = async (reset = false) => {
    if (historyLoading.value || historyLoadingMore.value) return;
    if (!historyHasMore.value && !reset) return;
    if (reset) {
      historyOffset.value = 0;
      historyHasMore.value = true;
    }
    if (reset) {
      historyLoading.value = true;
    } else {
      historyLoadingMore.value = true;
    }
    historyError.value = '';
    try {
      const params = new URLSearchParams({
        limit: String(20),
        offset: String(historyOffset.value),
      });
      const response = await fetch(`/api/agent/sessions?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const result = await response.json();
      const payload = result.data || {};
      const items = payload.items || [];
      if (reset) {
        sessionHistory.value = items;
        if (deps.currentSessionId.value) {
          const matched = items.find(item => item.session_id === deps.currentSessionId.value);
          if (matched) {
            pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(matched.metadata?.workspace_root || pendingWorkspaceRoot.value);
            pendingEntryAgent.value = matched.metadata?.entry_agent || pendingEntryAgent.value;
            currentSessionTeam.value = matched.metadata?.team || currentSessionTeam.value;
          }
        }
      } else {
        sessionHistory.value = sessionHistory.value.concat(items);
      }
      historyOffset.value += items.length;
      historyHasMore.value = payload.has_more ?? items.length >= 20;
    } catch (error) {
      historyError.value = '加载失败，请重试';
      deps.showToast('加载历史列表失败', retryLoadHistory);
    } finally {
      historyLoading.value = false;
      historyLoadingMore.value = false;
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
    if (deps.currentSessionId.value === sessionId && pendingWorkspaceRoot.value !== normalizedWorkspaceRoot) {
      pendingWorkspaceRoot.value = normalizedWorkspaceRoot;
    }
    const currentMetadata = deps.currentSessionId.value === sessionId
      ? {
          ...(currentSessionTeam.value.trim() ? { team: currentSessionTeam.value.trim() } : {}),
          ...(normalizedWorkspaceRoot ? { workspace_root: normalizedWorkspaceRoot } : {}),
          ...(pendingEntryAgent.value.trim() ? { entry_agent: pendingEntryAgent.value.trim() } : {}),
        }
      : {};
    const nextItem = {
      session_id: sessionId,
      title: summary,
      first_message: summary,
      last_message: normalizedContent,
      last_message_at: time,
      unread_count: 0,
      metadata: currentMetadata,
    };
    const idx = sessionHistory.value.findIndex(h => h.session_id === sessionId);
    if (idx >= 0) {
      const item = sessionHistory.value[idx];
      Object.assign(item, nextItem, {
        title: summary || item.title || '',
        first_message: item.first_message || summary,
        metadata: { ...(item.metadata || {}), ...currentMetadata },
      });
      if (idx === 0) {
        deps.onSessionUpdated?.(item);
        return;
      }
      sessionHistory.value.splice(idx, 1);
      sessionHistory.value.unshift(item);
      deps.onSessionUpdated?.(item);
    } else {
      sessionHistory.value.unshift(nextItem);
      deps.onSessionUpdated?.(nextItem);
    }
  };

  const exportCurrentSession = async () => {
    const sessionId = deps.currentSessionId.value;
    if (!sessionId) {
      deps.showToast('当前无会话');
      return;
    }
    if (isExportingSession.value) return;

    isExportingSession.value = true;
    try {
      const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/export`);
      if (!response.ok) {
        let errorMessage = '导出会话失败';
        try {
          const result = await response.json();
          errorMessage = result.detail || result.message || errorMessage;
        } catch (_) {}
        throw new Error(errorMessage);
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition') || '';
      const match = contentDisposition.match(/filename\*?=(?:UTF-8''|")?([^\";]+)/i);
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
    if (sessionId && sessionId !== deps.currentSessionId.value) {
      deps.disconnectSessionWS();
      deps.invalidateActiveStream();
      deps.clearExecutionState();
      deps.isLoading.value = false;
      deps.currentSessionId.value = sessionId;
      const matched = sessionHistory.value.find(item => item.session_id === sessionId);
      pendingWorkspaceRoot.value = normalizeWorkspaceRootInput(matched?.metadata?.workspace_root || '');
      pendingEntryAgent.value = matched?.metadata?.entry_agent || '';
      currentSessionTeam.value = matched?.metadata?.team || '';
      deps.clearComposerAttachments();
      await deps.loadSessionMessages(sessionId);
      await deps.loadSessionFiles(sessionId);
      deps.connectSessionWS(sessionId);
      // 消息加载完成后独立检查任务状态（不在 loadSessionMessages 内部调用）
      await deps.checkSessionTaskStatus(sessionId);
      return;
    }

    if (!sessionId && deps.currentSessionId.value) {
      deps.disconnectSessionWS();
      deps.invalidateActiveStream();
      deps.clearExecutionState();
      deps.isLoading.value = false;
      deps.currentSessionId.value = null;
      deps.sessionFiles.value = [];
      pendingWorkspaceRoot.value = '';
      pendingEntryAgent.value = '';
      loadActiveTeam();
      deps.clearComposerAttachments();
      deps.messages.value = [];
      deps.sessionFilesDrawerVisible.value = false;
      deps.sessionFilesDrawerTarget.value = 'composer';
    }
  };

  const ensureSession = async () => {
    if (deps.currentSessionId.value) {
      deps.connectSessionWS(deps.currentSessionId.value);
      return deps.currentSessionId.value;
    }
    const userId = (localStorage.getItem('userId') || '').trim();
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
    const response = await fetch('/api/agent/sessions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    const sessionId = result.data?.session_id || null;
    if (sessionId) {
      const now = new Date().toISOString();
      const sessionMetadata = {
        ...(team ? { team } : {}),
        ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}),
        ...(entryAgent ? { entry_agent: entryAgent } : {}),
        ...(result.data?.metadata || {}),
      };
      deps.onSessionCreated?.({
        session_id: sessionId,
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
      await router.push(getChatSessionPath(sessionId));
      if (deps.currentSessionId.value !== sessionId) {
        deps.currentSessionId.value = sessionId;
      }
      deps.connectSessionWS(sessionId);
      await deps.loadSessionFiles(sessionId);
    }
    return deps.currentSessionId.value;
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
