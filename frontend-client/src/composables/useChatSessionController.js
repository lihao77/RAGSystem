import { ref } from 'vue';
import { useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useDictionariesStore } from '../stores/dictionaries.js';
import { useSessionListStore } from '../stores/session-list.js';
import { useSessionRunStore } from '../stores/session-run.js';
import { UNASSIGNED_WORKSPACE_ID, useWorkspaceStore } from '../stores/workspace.js';
import { useLlmStore } from '../stores/llm.js';
import { useThinkingStore } from '../stores/thinking.js';
import { setActiveSessionId, setSelectionChangeListener } from '../stores/sessionScope.js';
import { resolveRestorableOverrides } from '../api/modelAdapter.js';
import { fetchDefaultLlm } from '../api/runtimeCore.js';
import { updateSessionRequestOverrides } from '../api/session.js';
import { getDefaultPermissionMode } from '../utils/permissionPresentation.js';

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

/** 会话占位标题（新建会话乐观插入用）。 */
export const PLACEHOLDER_SESSION_TITLE = '新会话';

/** 首条消息的乐观标题：与后端投影派生兜底（首行压空白、截 30 字符）保持一致。 */
export const deriveDisplaySessionTitle = (content) => {
  const firstLine = String(content || '').split(/\r?\n/, 1)[0] || '';
  return firstLine.replace(/\s+/g, ' ').trim().slice(0, 30);
};

/** LLM 标题异步生成完成前的延迟重试节奏（秒级；生成通常 1~3s 内完成）。 */
const TITLE_SYNC_DELAYS_MS = [4000, 12000];
const TITLE_SYNC_FINAL_CLEAR_MS = 20_000;
const pendingTitleSyncs = new Set();

/**
 * 首条消息发送成功后的标题回显：
 * 1) 立即以派生兜底替换占位"新会话"（与后端投影初始值一致）；
 * 2) 延迟拉取会话详情，把 LLM 生成的标题带回侧边栏（标题只生成一次，重复发送不重排）。
 */
export const syncSessionTitleAfterFirstMessage = ({ sessionListStore, chatSdkClient, sessionId, content }) => {
  if (!sessionId || !chatSdkClient) return;
  const item = sessionListStore.getById(sessionId);
  // 已有真实标题的会话（非首条消息）不参与：后端只对首条可见用户消息生成标题。
  if (!item || (item.title && item.title !== PLACEHOLDER_SESSION_TITLE)) return;
  const fallbackTitle = deriveDisplaySessionTitle(content);
  if (fallbackTitle) sessionListStore.updateTitle(sessionId, fallbackTitle);
  if (pendingTitleSyncs.has(sessionId)) return;
  pendingTitleSyncs.add(sessionId);
  const syncOnce = async () => {
    try {
      const response = await chatSdkClient.getSession(sessionId);
      const title = response?.data?.title;
      if (typeof title === 'string' && title && title !== PLACEHOLDER_SESSION_TITLE) {
        sessionListStore.updateTitle(sessionId, title);
        pendingTitleSyncs.delete(sessionId);
      }
    } catch {
      // 静默重试：下一次延迟或列表刷新自然带回。
    }
  };
  for (const delay of TITLE_SYNC_DELAYS_MS) setTimeout(syncOnce, delay);
  setTimeout(() => pendingTitleSyncs.delete(sessionId), TITLE_SYNC_FINAL_CLEAR_MS);
};

/**
 * 聊天页的会话入口、历史、创建与导出控制。
 */
export function useChatSessionController(deps) {
  const router = useRouter();
  const dictStore = useDictionariesStore();
  const sessionListStore = useSessionListStore();
  const sessionRunStore = useSessionRunStore();
  const workspaceStore = useWorkspaceStore();
  const llmStore = useLlmStore();
  const thinkingStore = useThinkingStore();
  const {
    currentSessionId,
    messages,
    currentSessionTeam,
    pendingWorkspaceRoot,
    pendingEntryAgent,
    sessionWorkspaceDisplay,
  } = storeToRefs(sessionRunStore);
  // 用户主动选择（模型/思考档位）即时落会话，与权限模式"选择即更新"对齐：
  // 仅激活会话时写；同一次交互里模型+档位连点合并为一次 PATCH；失败静默——
  // 丢一次即时落库只影响"未发送选择的恢复"，发送路径后端仍会补写同键。
  const persistRequestOverrides = deps.persistRequestOverrides ?? updateSessionRequestOverrides;
  const resolveDefaultLlm = deps.fetchDefaultLlm ?? fetchDefaultLlm;
  let overridePersistTimer = null;
  setSelectionChangeListener(() => {
    const sessionId = currentSessionId.value;
    if (!sessionId) return;
    // 通知时刻快照生效对：定时器触发时会话可能已切走，写目标与值必须同源
    const overrides = {
      selectedLLM: llmStore.selectedLLM || '',
      thinkingLevel: thinkingStore.thinkingLevel || '',
    };
    clearTimeout(overridePersistTimer);
    overridePersistTimer = setTimeout(() => {
      persistRequestOverrides(sessionId, overrides).catch(() => {});
    }, 0);
  });
  const teamOptions = ref([]);
  const teamLoading = ref(false);
  const entryAgentOptions = ref([]);
  const entryAgentLoading = ref(false);
  const isExportingSession = ref(false);
  let entryAgentLoadSeq = 0;
  let routeSyncSeq = 0;

  /**
   * Sending a message must not race a reconnect.  The old implementation
   * kicked off an unconditional cursor reconnect for every send and returned
   * immediately; the next SDK send then observed a connecting socket and was
   * diverted to the fallback transport (or rejected).
   */
  const ensureSessionConnection = async (sessionId) => {
    if (!sessionId) return;
    const client = deps.chatSdkClient;
    if (client?.sessionId === sessionId && client?.isConnected === true) return;
    await deps.connectSessionWS(sessionId);
  };

  const getChatSessionPath = (sessionId) => (sessionId
    ? `/chat/${encodeURIComponent(sessionId)}`
    : '/');

  const syncTeamOptions = (result) => {
    const teams = Array.isArray(result?.teams) ? result.teams : [];
    const activeTeam = result?.active_team || '';
    teamOptions.value = teams.map((team) => {
      const isActive = team.team_name === activeTeam;
      return {
        value: team.team_name,
        label: isActive ? `${team.team_name}（默认）` : team.team_name,
        isActive,
      };
    });
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
   * 已有 Session 始终使用服务端返回的固定 Team snapshot 身份。
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

  /**
   * 级联选择器单次提交 team + entryAgent，避免「改 team 清空 agent 再回填」的中间态。
   * entryAgent 留空 = 使用该 team 的默认入口 Agent（与服务端兜底语义一致）；
   * loadEntryAgentOptions 会校验 agent 在该 team 下仍存在且启用，否则清空。
   */
  const setPendingTeamAgent = async (teamName, agentName = '') => {
    const next = (teamName || '').trim();
    const agent = (agentName || '').trim();
    if (next === currentSessionTeam.value.trim() && agent === pendingEntryAgent.value.trim()) return;
    currentSessionTeam.value = next;
    pendingEntryAgent.value = agent;
    await loadEntryAgentOptions(next);
  };

  const hydrateSessionContext = async (sessionId, listItem = null, isCurrent = () => true) => {
    const client = deps.chatSdkClient;
    if (!client) throw new Error('Chat SDK 未初始化');
    const result = await client.getSession(sessionId);
    if (!isCurrent()) return false;
    const detail = result.data;
    // 会话维度恢复：最近一次发送/选择的模型+思考档位覆盖（校验通过才建覆盖层；
    // 无记录（存量会话）返回 null 不动全局默认）。providers 走 dictionaries 缓存
    // （消除聊天页重复拉取）；失败/无记录均静默回落——恢复是回显增强，不阻塞会话加载。
    try {
      const providers = await dictStore.ensureProviders();
      // "默认模型 + 档位"记录按会话团队与入口 Agent 解析默认生效模型校验（与执行路径同源）
      const defaultLlm = await resolveDefaultLlm(detail?.team_name || '', detail?.entry_agent_name || '');
      if (isCurrent()) {
        const restorable = resolveRestorableOverrides(detail?.metadata, providers, defaultLlm);
        if (restorable) {
          llmStore.applySessionOverride(sessionId, restorable.selectedLLM);
          thinkingStore.applySessionOverride(sessionId, restorable.thinkingLevel);
        }
      }
    } catch {
      // ensureProviders/解析异常均兜底；恢复失败不影响主流程
    }
    const workspace = detail.workspace || listItem?.workspace || null;
    const workspaceRoot = normalizeWorkspaceRootInput(workspace?.root_path || '');
    sessionRunStore.applySessionContext({
      team: detail.team_name || '',
      entryAgent: detail.entry_agent_name || '',
      workspaceRoot,
      workspaceDisplay: workspace?.display_name || workspaceRoot || '',
    });
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
      const client = deps.chatSdkClient;
      if (!client) throw new Error('Chat SDK 未初始化');
      const exported = await client.exportSession(sessionId);
      const { blob, headers } = exported && typeof exported.blob === 'function'
        ? { blob: await exported.blob(), headers: exported.headers }
        : exported;
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
    sessionRunStore.clearSessionContext();
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
      deps.clearExecutionState({ resetContextUsage: true });
      sessionRunStore.resetSessionParticipants();
      currentSessionId.value = sessionId;
      setActiveSessionId(sessionId);
      // 不先清空上下文：列表无 team，清空会先闪「未选择」；
      // workspace 能从列表立刻 seed，team 等 hydrate 覆盖（短暂保留上一会话 team 优于假空）。
      const matched = sessionListStore.getById(sessionId);
      if (matched?.workspace) {
        const seedRoot = normalizeWorkspaceRootInput(matched.workspace.root_path || '');
        pendingWorkspaceRoot.value = seedRoot;
        sessionWorkspaceDisplay.value = matched.workspace.display_name || seedRoot || '';
      }
      if (!await hydrateSessionContext(sessionId, matched, isCurrent)) return;
      deps.clearComposerAttachments();
      try {
        await deps.connectSessionWS(sessionId);
        await deps.waitForSessionRuntime(sessionId);
      } catch (error) {
        if (isCurrent()) deps.showToast(error?.message || '实时连接失败，请稍后重试', 'warning');
      }
      if (!isCurrent()) return;
      await deps.loadContextSnapshot?.(sessionId);
      if (!isCurrent()) return;
      await deps.loadSessionFiles(sessionId);
      return;
    }

   if (!sessionId && currentSessionId.value) {
     deps.disconnectSessionWS();
     deps.invalidateActiveStream();
      deps.clearExecutionState({ resetContextUsage: true });
      currentSessionId.value = null;
      setActiveSessionId('');
      sessionRunStore.resetSessionParticipants();
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
      await ensureSessionConnection(currentSessionId.value);
      return currentSessionId.value;
    }
    const workspaceRoot = normalizeWorkspaceRootInput(pendingWorkspaceRoot.value);
    pendingWorkspaceRoot.value = workspaceRoot;
    const entryAgent = pendingEntryAgent.value.trim();
    if (!currentSessionTeam.value.trim()) {
      await loadActiveTeam();
    }
    const team = currentSessionTeam.value.trim();
    const selectedWorkspaceId = workspaceStore.currentWorkspaceId || UNASSIGNED_WORKSPACE_ID;
    const body = selectedWorkspaceId && selectedWorkspaceId !== UNASSIGNED_WORKSPACE_ID
      ? { workspace: { kind: 'existing', workspace_id: selectedWorkspaceId } }
      : workspaceRoot
        ? { workspace: { kind: 'local_path', root_path: workspaceRoot } }
        : {};
    if (team) body.team_name = team;
    if (entryAgent) body.entry_agent_name = entryAgent;
    body.permission_mode = getDefaultPermissionMode();
    const client = deps.chatSdkClient;
    if (!client) throw new Error('Chat SDK 未初始化');
    const result = await client.createSession(body);
    const sessionId = result.data?.session_id || null;
    if (sessionId) {
      const now = new Date().toISOString();
      // 服务端返回优先，本地选择作兜底
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
      const nextWorkspaceRoot = normalizeWorkspaceRootInput(result.data.workspace?.root_path || workspaceRoot);
      sessionRunStore.applySessionContext({
        team: result.data?.team_name || team,
        entryAgent: result.data?.entry_agent_name || entryAgent,
        workspaceRoot: nextWorkspaceRoot,
        workspaceDisplay: result.data.workspace?.display_name || nextWorkspaceRoot || '',
      });
      if (currentSessionId.value !== sessionId) {
        currentSessionId.value = sessionId;
        setActiveSessionId(sessionId);
      }
      const navigate = replaceRoute ? router.replace : router.push;
      await navigate(getChatSessionPath(sessionId));
      await ensureSessionConnection(sessionId);
      await deps.loadSessionFiles(sessionId);
      await deps.loadSessionParticipants?.(sessionId);
    }
    return currentSessionId.value;
  };

  return {
    currentSessionTeam,
    teamOptions,
    teamLoading,
    pendingWorkspaceRoot,
    pendingEntryAgent,
    sessionWorkspaceDisplay,
    entryAgentOptions,
    entryAgentLoading,
    isExportingSession,
    normalizeWorkspaceRootInput,
    loadEntryAgentOptions,
    loadActiveTeam,
    setPendingTeam,
    setPendingTeamAgent,
    exportCurrentSession,
    updateRecentSession,
    syncSessionFromRoute,
    ensureSession,
  };
}
