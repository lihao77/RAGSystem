<template>
  <div class="chat-page-shell">
    <main class="chat-main" :class="{ 'has-messages': messages.length > 0, 'workbench-layout': visibleWorkPanel, 'is-new-chat': messages.length === 0, 'is-launching-chat': newChatLaunching, 'is-switching-to-new-chat': switchingToNewChat }">
    <div class="chat-conversation-column">
      <SessionContextBar
        ref="sessionContextBarRef"
        :selected-llm="selectedLLM"
        :is-dark="isDark"
        :current-session-id="currentSessionId || ''"
        :is-exporting-session="isExportingSession"
        :scrolled="topControlsBarScrolled"
        @update:selectedLLM="emit('update:selectedLLM', $event)"
        @toggle-theme="emit('toggleTheme')"
        @open-mobile-sidebar="openMobileSidebar"
        @export-session="exportCurrentSession"
      />
      <div class="chat-messages-wrapper" ref="messagesRef" @scroll="handleScroll">
        <ChatMessageList
          v-model:editing-draft="editingDraft"
          :messages-loading="messagesLoading"
          :messages="messages"
          :visible-messages="visibleMessages"
          :current-session-id="currentSessionId || ''"
          :show-work-panel="visibleWorkPanel"
          :is-loading="isLoading"
          :selected-work-panel-message-key="selectedWorkPanelMessageKey"
          :editing-message="editingMessage"
          :editing-attachments-draft="editingAttachmentsDraft"
          :editing-submitting="editingSubmitting"
          :message-key="messageKey"
          :has-execution-content="hasExecutionContent"
          :toggle-execution-view="toggleExecutionView"
          :get-assistant-runtime-status-text="getAssistantRuntimeStatusText"
          :parse-message-parts="parseMessageParts"
          :render-markdown="renderMarkdown"
          :handle-enter-situation="handleEnterSituation"
          :parse-task-notifications="parseTaskNotifications"
          :is-image-attachment="isImageAttachment"
          :get-attachment-preview-url="getAttachmentPreviewUrl"
          :format-attachment-meta="formatAttachmentMeta"
          :confirm-edit-and-resend="confirmEditAndResend"
          :cancel-edit="cancelEdit"
          :open-session-files-drawer="openSessionFilesDrawer"
          :remove-editing-attachment="removeEditingAttachment"
          :start-edit-message="startEditMessage"
          :copy-message="copyMessage"
          :get-work-panel-message-key="getWorkPanelMessageKey"
          :select-work-panel-message="selectWorkPanelMessage"
          :rollback-and-retry="rollbackAndRetry"
          :get-message-execution-time-text="getMessageExecutionTimeText"
          :get-message-execution-time-title="getMessageExecutionTimeTitle"
          @notify="({ message, type }) => showToast(message, type)"
        >
          <template #empty>
            <ChatEmptyState @select-prompt="applyNewChatSuggestion" />
          </template>
        </ChatMessageList>
        <!-- <div class="input-area-wrapper" :class="{ 'centered': messages.length === 0 }"> -->
        <div class="bottom-dock" :class="{ 'bottom-dock--new-chat': messages.length === 0, 'bottom-dock--launching': newChatLaunching && messages.length > 0 }">
          <transition name="scroll-btn-fade">
            <LiquidGlass v-if="showScrollToBottomButton" :width="40" :height="40" :radius="999"
              extra-filter="blur(2px) contrast(1.15) brightness(1.06) saturate(1.1)"
              class="scroll-to-bottom-btn" @click="onScrollToBottomClick" title="滚动到底部">
              <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9"></polyline>
              </svg>
            </LiquidGlass>
          </transition>
          <div class="input-area-wrapper">
          <ChatInput
            ref="chatInputRef"
            v-model="inputMessage"
            :attachments="pendingAttachments"
            :isLoading="isLoading"
            @send="handleSend"
            @stop="handleStop"
            @openAttachments="() => openSessionFilesDrawer('composer')"
            @removeAttachment="removePendingAttachment"
            @pasteFiles="handleSessionFileSelect"
          >
            <template #footerMeta>
              <div class="composer-status-row">
                <TaskLauncher
                  v-if="messages.length === 0"
                  v-model:entry-agent="pendingEntryAgent"
                  v-model:workspace-root="pendingWorkspaceRoot"
                  :entry-agent-options="entryAgentOptions"
                  :entry-agent-loading="entryAgentLoading"
                  :normalize-workspace-root-input="normalizeWorkspaceRootInput"
                />
                <div v-if="contextUsage && contextUsage.max > 0" class="context-usage-content" @click="openCtxDrawer" title="点击查看上下文详情">
                  <svg width="22" height="22" viewBox="0 0 22 22" class="ctx-ring-master" :title="`上下文: ${contextUsage.used.toLocaleString()} / ${contextUsage.max.toLocaleString()} tokens`">
                    <circle cx="11" cy="11" r="9" fill="none" :stroke="'var(--ctx-ring-track)'" stroke-width="2.5" />
                    <circle
                      cx="11"
                      cy="11"
                      r="9"
                      fill="none"
                      :stroke="contextUsageClass === 'danger' ? 'var(--ctx-ring-danger)' : contextUsageClass === 'warning' ? 'var(--ctx-ring-warning)' : 'var(--ctx-ring-success)'"
                      stroke-width="2.5"
                      stroke-linecap="round"
                      :stroke-dasharray="`${contextUsagePct * 0.5655} 56.55`"
                      stroke-dashoffset="0"
                      :style="{ transform: 'rotate(90deg) scaleX(-1)', transformOrigin: '50% 50%' }"
                    />
                  </svg>
                  <span class="context-usage-label">{{ contextUsage.used.toLocaleString() }} / {{ contextUsage.max.toLocaleString() }} tokens</span>
                  <span v-if="isCompressing" class="compressing-indicator">
                    <span class="compressing-dot"></span>
                    压缩中
                  </span>
                </div>
              </div>
            </template>
            <template #rightActions>
              <SessionContextInfoButton
                :current-session-id="currentSessionId || ''"
                :team="currentSessionTeam"
                :entry-agent="pendingEntryAgent"
                :workspace-root="pendingWorkspaceRoot"
                :execution-status-text="executionStatusText"
                :show-execution-status="showExecutionPill"
                :execution-observability="sessionExecutionObservability"
              />
            </template>
          </ChatInput>
        </div>
      </div>
    </div>
    </div><!-- end .chat-conversation-column -->
    <ApprovalQueueHost
      ref="approvalQueueHostRef"
      :show-work-panel="visibleWorkPanel"
      :disable-transition="switchingToNewChat"
      :active-run="_activeRun"
      :current-message="currentRunMessage"
      :approval-queue="approvalQueue"
      :approval-submitting-id="approvalSubmittingId"
      :pending-user-input="pendingUserInput"
      :context-usage="contextUsage"
      :session-id="currentSessionId || ''"
      :message-key="currentRunMessageKey"
      @approval-submit="({ approvalId, approved, message }) => submitApproval(approvalId, approved, message, currentSessionId)"
      @user-input-submit="handleWorkPanelUserInputSubmit"
      @user-input-cancel="handleWorkPanelUserInputCancel"
      @artifact-select="handleArtifactSelect"
    />
    </main>
    <AppToast ref="toastRef" />

    <!-- 上下文快照抽屉 -->
    <ContextSnapshotDrawer
      :visible="ctxDrawerVisible"
      :session-id="currentSessionId"
      :selected-llm="ctxDrawerSelectedLlm"
      @close="ctxDrawerVisible = false"
    />

    <SessionFilesDrawer
      :visible="sessionFilesDrawerVisible"
      :mode="sessionFilesDrawerTarget"
      :session-id="currentSessionId || ''"
      :files="sessionFiles"
      :pending-files="currentDrawerPendingFiles"
      :loading="sessionFilesLoading"
      :uploading="uploadingSessionFiles"
      :deleting-file-id="deletingSessionFileId || ''"
      @close="() => { sessionFilesDrawerVisible = false; sessionFilesDrawerTarget = 'composer'; }"
      @refresh="currentSessionId && loadSessionFiles(currentSessionId)"
      @upload="handleSessionFileSelect"
      @download="downloadSessionFileItem"
      @delete="removeSessionFile"
      @reuse="reuseSessionFileAsAttachment"
      @removePending="sessionFilesDrawerTarget === 'message-edit' ? removeEditingAttachment($event) : removePendingAttachment($event)"
    />

    <!-- 文件预览确认对话框 -->
    <FilePreviewConfirmDialog ref="filePreviewDialogRef" />

    <!-- 态势大屏 -->
    <SituationScreen
      v-if="situationScreenActive"
      :artifact-id="situationArtifactId"
      :map-data="situationMapData"
      :messages="messages"
      :is-streaming="isLoading"
      :situation-info="situationInfo"
      @close="situationScreenActive = false"
      @send-message="handleSituationSendMessage"
    />
</div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch, inject } from 'vue';
import { useRoute } from 'vue-router';
import { renderMarkdown } from '../utils/markdown';
import { applyStep } from '../utils/executionProjector';
import { shouldRefreshSessionMessagesAfterResume, shouldRunResumeRecoveryWatchdog } from '../utils/sessionSocket';
import { useActiveRunState } from '../composables/useActiveRunState';
import { useChatSessionController } from '../composables/useChatSessionController';
import { useSessionConnection } from '../composables/useSessionConnection';
import { useSessionTaskStatus } from '../composables/useSessionTaskStatus';
import { useSessionMessages } from '../composables/useSessionMessages';
import { useSessionRunStream } from '../composables/useSessionRunStream';
import { useMessageRevision } from '../composables/useMessageRevision';
import { useSessionFilesAttachments } from '../composables/useSessionFilesAttachments';
import { useApprovalQueue } from '../composables/useApprovalQueue';
import { useSessionSend } from '../composables/useSessionSend';
import { useChatScrolling } from '../composables/useChatScrolling';
import { useMessageArtifacts } from '../composables/useMessageArtifacts';
import { useLlmRetryState } from '../composables/useLlmRetryState';
import { useChatMessageRuntime } from '../composables/useChatMessageRuntime';
import { useMessageListView } from '../composables/useMessageListView';
import { useRuntimeStatusView } from '../composables/useRuntimeStatusView';
import { normalizeSessionAttachment as normalizeAttachmentUtil } from '../utils/sessionAttachments';
import ChatInput from '../components/ChatInput.vue';
import SessionFilesDrawer from '../components/SessionFilesDrawer.vue';
import SituationScreen from '../components/SituationScreen.vue';

import LiquidGlass from '../components/LiquidGlass.vue';
import FilePreviewConfirmDialog from '../components/FilePreviewConfirmDialog.vue';
import ContextSnapshotDrawer from '../components/ContextSnapshotDrawer.vue';
import AppToast from '../components/AppToast.vue';
import ChatMessageList from '../components/chat/ChatMessageList.vue';
import ChatEmptyState from '../components/chat/ChatEmptyState.vue';
import SessionContextBar from '../components/chat/SessionContextBar.vue';
import SessionContextInfoButton from '../components/chat/SessionContextInfoButton.vue';
import ApprovalQueueHost from '../components/chat/ApprovalQueueHost.vue';
import TaskLauncher from '../components/chat/TaskLauncher.vue';
import { useWorkbenchLayout } from '../composables/useWorkbenchLayout';

// Props
const props = defineProps({
  selectedLLM: {
    type: String,
    default: ''
  },
  isDark: {
    type: Boolean,
    default: true
  },
  onSessionCreated: {
    type: Function,
    default: null,
  },
  onSessionUpdated: {
    type: Function,
    default: null,
  }
});

// Emits
const emit = defineEmits(['update:selectedLLM', 'toggleTheme']);

const route = useRoute();
const shellSidebarControl = inject('shellSidebarControl', null);

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const sessionContextBarRef = ref(null);
const topControlsBarScrolled = ref(false);
const {
  messagesRef,
  showScrollToBottomButton,
  updateScrollBottomGap,
  waitForScrollLayout,
  scrollToBottom,
  resetFollowing,
  resetScrollPosition,
  stickToBottom,
  handleScroll,
  onScrollToBottomClick,
} = useChatScrolling({ messages, topControlsBarScrolled });

const currentSessionId = ref(null);
const sessionFilesDrawerVisible = ref(false);
const sessionFilesDrawerTarget = ref('composer');
const chatInputRef = ref(null);
const approvalQueueHostRef = ref(null);
const filePreviewDialogRef = ref(null);
const toastRef = ref(null);
const isCompressing = ref(false);
const ctxDrawerVisible = ref(false);
const ctxDrawerSelectedLlm = ref('');
const newChatLaunching = ref(false);
const switchingToNewChat = ref(false);
let newChatLaunchTimer = null;

function getCurrentSelectedLlm() {
  return sessionContextBarRef.value?.getSelection?.() || props.selectedLLM || localStorage.getItem('selectedLLMModel') || '';
}

function openCtxDrawer() {
  ctxDrawerSelectedLlm.value = getCurrentSelectedLlm();
  ctxDrawerVisible.value = true;
}

const { activeRun: _activeRun } = useActiveRunState();

// ── Composables ─────────────────────────────────────────────────────────
// 注意：deps 中的函数通过闭包引用，在调用时（非初始化时）解析，
// 因此可以安全引用后续定义的函数（scrollToBottom, showToast 等）。

const {
  llmRetryState,
  formatRetryCountdown,
  setLlmRetryState,
  clearLlmRetryState,
} = useLlmRetryState({
  messages,
  activeRun: _activeRun,
});

const {
  createAssistantMessage,
  normalizeAssistantExecutionState,
  hasExecutionContent,
  ensureExecutionProjector,
  syncExecutionProjection,
  ensureExecutionStepsLoaded,
  toggleExecutionView,
  createAssistantMessageFromHistory,
  isRootEvent,
  isMasterEvent,
  findSubtaskByCallId,
  findRunningSubtaskByAgentName,
  getMessageExecutionTimeText,
  getMessageExecutionTimeTitle,
  selectedWorkPanelMessageKey,
  getWorkPanelMessageKey,
  currentRunMessage,
  currentRunMessageKey,
  selectWorkPanelMessage,
  parseTaskNotifications,
  buildTaskNotificationMessage,
} = useChatMessageRuntime({
  currentSessionId,
  messages,
  activeRun: _activeRun,
  showToast: (...a) => showToast(...a),
});

const {
  messagesLoading, cacheMessages, deleteMessageCache,
  loadSessionMessages, mergeMessageIdsFromServer,
} = useSessionMessages({
  currentSessionId, messages,
  normalizeAssistantExecutionState,
  createAssistantMessageFromHistory: (...a) => createAssistantMessageFromHistory(...a),
  normalizeAttachment: (...a) => normalizeAttachmentUtil(...a),
  scrollToBottom: (...a) => scrollToBottom(...a),
  waitForScrollLayout: () => waitForScrollLayout(),
  focusInput: () => focusInput(),
  loadContextSnapshot: (...a) => loadContextSnapshot(...a),
  showToast: (...a) => showToast(...a),
  invalidateActiveStream: () => invalidateActiveStream(),
});

const {
  sessionTaskInfo, sessionExecutionObservability, contextUsage,
  mergeExecutionObservability,
  loadContextSnapshot, refreshSessionExecutionState,
  checkSessionTaskStatus, clearExecutionState: _clearExecutionStateBase, beginOptimisticExecutionState,
} = useSessionTaskStatus({
  currentSessionId, messages, isLoading,
  shouldRefreshFn: shouldRefreshSessionMessagesAfterResume,
  shouldRunWatchdogFn: shouldRunResumeRecoveryWatchdog,
  getActiveRun: () => _activeRun,
  invalidateActiveStream: () => invalidateActiveStream(),
  loadSessionMessages,
  deleteMessageCache,
  createAssistantMessage,
  scheduleCommandFallback: (...a) => scheduleCommandFallback(...a),
  scheduleResumeRecovery: (...a) => scheduleSessionResumeRecovery(...a),
  clearLlmRetryState: () => clearLlmRetryState(),
});

const {
  contextUsagePct,
  contextUsageClass,
  getAssistantRuntimeStatusText,
  executionStatusText,
  showExecutionPill,
} = useRuntimeStatusView({
  currentSessionId,
  messages,
  isLoading,
  activeRun: _activeRun,
  llmRetryState,
  formatRetryCountdown,
  sessionTaskInfo,
  sessionExecutionObservability,
  contextUsage,
});

const { showWorkPanel } = useWorkbenchLayout();

const {
  approvalQueue,
  approvalSubmittingId,
  pendingUserInput,
  enqueueApproval,
  handleApprovalResolved,
  submitApproval,
  resetApprovalState,
  showUserInput,
  handleWorkPanelUserInputSubmit,
  handleWorkPanelUserInputCancel,
} = useApprovalQueue({
  showWorkPanel,
  currentSessionId,
  approvalQueueHostRef,
  filePreviewDialogRef,
  getWS: () => getWS(),
  showToast: (...a) => showToast(...a),
});

const effectiveShowWorkPanel = computed(() => (
  showWorkPanel.value
  && (
    messages.value.length > 0
    || isLoading.value
    || _activeRun.active
    || approvalQueue.value.length > 0
    || Boolean(pendingUserInput.value)
  )
));
const visibleWorkPanel = computed(() => effectiveShowWorkPanel.value && !switchingToNewChat.value);

const {
  invalidateActiveStream, scheduleCommandFallback, clearCommandFallback,
  clearSessionResumeRecovery, scheduleSessionResumeRecovery,
  connectSessionWS, disconnectSessionWS, getWS,
} = useSessionConnection({
  currentSessionId, messages, isLoading, isCompressing,
  activeRun: _activeRun,
  onMessage: (...a) => handleWSMessage(...a),
  onRunFinalized: (sid) => _finalizeActiveRun(sid),
  resetApprovalState: () => resetApprovalState(),
  loadSessionMessages,
  deleteMessageCache,
  clearLlmRetryState: () => clearLlmRetryState(),
  cacheMessages,
  refreshSessionExecutionState,
  scrollToBottom: (...a) => scrollToBottom(...a),
});
const {
  sessionFiles,
  pendingAttachments,
  sessionFilesLoading,
  uploadingSessionFiles,
  deletingSessionFileId,
  normalizeAttachment,
  isImageAttachment,
  formatAttachmentMeta,
  getAttachmentPreviewUrl,
  currentDrawerPendingFiles,
  removePendingAttachment,
  removeEditingAttachment,
  reuseSessionFileAsAttachment,
  loadSessionFiles,
  openSessionFilesDrawer,
  handleSessionFileSelect,
  materializeAttachmentsForSend,
  clearComposerAttachments,
  clearEditingAttachments,
  downloadSessionFileItem,
  removeSessionFile,
} = useSessionFilesAttachments({
  currentSessionId,
  sessionFilesDrawerVisible,
  sessionFilesDrawerTarget,
  getEditingAttachmentsDraft: () => editingAttachmentsDraft.value,
  setEditingAttachmentsDraft: (value) => { editingAttachmentsDraft.value = value; },
  ensureSession: (...a) => ensureSession(...a),
  showToast: (...a) => showToast(...a),
});

const {
  editingMessage,
  editingDraft,
  editingAttachmentsDraft,
  editingSubmitting,
  startEditMessage,
  resetEditingState,
  cancelEdit,
  confirmEditAndResend,
  rollbackAndRetry,
} = useMessageRevision({
  messages,
  currentSessionId,
  sessionFilesDrawerVisible,
  sessionFilesDrawerTarget,
  normalizeAttachment,
  showToast: (...a) => showToast(...a),
  cacheMessages,
  inputMessage,
  handleSend: (...a) => handleSend(...a),
});

// ── 态势大屏与消息产物 ──────────────────────────────────────────
const situationScreenActive = ref(false);
const situationArtifactId = ref(null);
const situationMapData = ref(null);
const situationInfo = ref(null);

const {
  parseMessageParts,
  handleArtifactSelect,
  checkSituationScreenTrigger,
  handleEnterSituation,
} = useMessageArtifacts({
  messagesRef,
  situationScreenActive,
  situationArtifactId,
  situationMapData,
  situationInfo,
});

const {
  handleWSMessage,
  finalizeActiveRun: _finalizeActiveRun,
} = useSessionRunStream({
  state: {
    currentSessionId,
    messages,
    isLoading,
    isCompressing,
    contextUsage,
    sessionTaskInfo,
    activeRun: _activeRun,
    llmRetryState,
  },
  messageStore: {
    createAssistantMessage,
    cacheMessages,
    deleteMessageCache,
    loadSessionMessages,
    mergeMessageIdsFromServer,
  },
  sessionStatus: {
    refreshSessionExecutionState,
    mergeExecutionObservability,
    updateRecentSession: (...a) => updateRecentSession(...a),
  },
  connection: {
    getWS,
    clearSessionResumeRecovery,
    clearCommandFallback,
    scheduleCommandFallback,
  },
  retry: {
    clearLlmRetryState: (...a) => clearLlmRetryState(...a),
    setLlmRetryState: (...a) => setLlmRetryState(...a),
  },
  execution: {
    ensureExecutionProjector: (...a) => ensureExecutionProjector(...a),
    syncExecutionProjection: (...a) => syncExecutionProjection(...a),
    findSubtaskByCallId: (...a) => findSubtaskByCallId(...a),
    findRunningSubtaskByAgentName: (...a) => findRunningSubtaskByAgentName(...a),
    isRootEvent: (...a) => isRootEvent(...a),
    isMasterEvent: (...a) => isMasterEvent(...a),
    applyStep,
  },
  approvals: {
    enqueueApproval: (...a) => enqueueApproval(...a),
    handleApprovalResolved: (...a) => handleApprovalResolved(...a),
    showUserInput,
  },
  notifications: {
    buildTaskNotificationMessage: (...a) => buildTaskNotificationMessage(...a),
  },
  artifacts: {
    checkSituationScreenTrigger: (...a) => checkSituationScreenTrigger(...a),
  },
  ui: {
    scrollToBottom: (...a) => scrollToBottom(...a),
    showToast: (...a) => showToast(...a),
  },
  sending: {
    handleStop: (...a) => handleStop(...a),
  },
});

// clearExecutionState 需要额外清理 view 级状态
const clearExecutionState = () => {
  _clearExecutionStateBase();
};

const {
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
} = useChatSessionController({
  state: {
    currentSessionId,
    isLoading,
    messages,
  },
  filesState: {
    sessionFiles,
    sessionFilesDrawerVisible,
    sessionFilesDrawerTarget,
  },
  messageStore: {
    loadSessionMessages,
  },
  files: {
    loadSessionFiles,
  },
  connection: {
    connectSessionWS,
    disconnectSessionWS,
    invalidateActiveStream,
  },
  runtime: {
    clearExecutionState: () => clearExecutionState(),
    checkSessionTaskStatus: (...a) => checkSessionTaskStatus(...a),
  },
  ui: {
    clearComposerAttachments: () => clearComposerAttachments(),
    showToast: (...a) => showToast(...a),
  },
  callbacks: {
    onSessionCreated: (...a) => props.onSessionCreated?.(...a),
    onSessionUpdated: (...a) => props.onSessionUpdated?.(...a),
  },
});

const {
  handleSend: sendSessionMessage,
  handleStop,
} = useSessionSend({
  state: {
    currentSessionId,
    messages,
    inputMessage,
    isLoading,
    activeRun: _activeRun,
    sessionTaskInfo,
    contextUsage,
  },
  composer: {
    pendingAttachments,
    getCurrentSelectedLlm: () => getCurrentSelectedLlm(),
  },
  session: {
    ensureSession: (...a) => ensureSession(...a),
    updateRecentSession,
  },
  connection: {
    getWS: () => getWS(),
    scheduleCommandFallback,
  },
  attachments: {
    materializeAttachmentsForSend,
    clearComposerAttachments,
  },
  messageStore: {
    cacheMessages,
  },
  editing: {
    resetEditingState: (...a) => resetEditingState(...a),
    clearEditingAttachments,
  },
  runtime: {
    beginOptimisticExecutionState,
    mergeExecutionObservability,
  },
  ui: {
    stickToBottom,
    showToast: (...a) => showToast(...a),
  },
});

const {
  messageKey,
  visibleMessages,
  copyMessage,
} = useMessageListView({
  messages,
  showToast: (...a) => showToast(...a),
});

// ── end Composables ─────────────────────────────────────────────────────

const showToast = (message, actionOrType = null, actionLabel = '重试') => {
  let type = 'error';
  let action = null;
  if (typeof actionOrType === 'string') {
    type = actionOrType;
  } else if (typeof actionOrType === 'function') {
    action = actionOrType;
  }
  toastRef.value?.show(message, action || type, actionLabel);
};

// 移动端状态

// 打开移动端侧边栏
const openMobileSidebar = () => {
  shellSidebarControl?.openMobileSidebar?.();
};

const focusInput = async () => {
  if (chatInputRef.value?.focus) {
    await chatInputRef.value.focus();
  }
};

const clearNewChatLaunchTimer = () => {
  if (!newChatLaunchTimer) return;
  window.clearTimeout(newChatLaunchTimer);
  newChatLaunchTimer = null;
};

const finishNewChatLaunchSoon = (delay = 680) => {
  clearNewChatLaunchTimer();
  newChatLaunchTimer = window.setTimeout(() => {
    newChatLaunching.value = false;
    newChatLaunchTimer = null;
  }, delay);
};

const handleSend = async (payload = null) => {
  const startsFromNewChat = messages.value.length === 0 && !currentSessionId.value;
  if (startsFromNewChat) {
    clearNewChatLaunchTimer();
    newChatLaunching.value = true;
  }

  try {
    await sendSessionMessage(payload);
  } finally {
    if (startsFromNewChat) {
      finishNewChatLaunchSoon(messages.value.length > 0 ? 620 : 220);
    }
  }
};

const applyNewChatSuggestion = async (prompt) => {
  inputMessage.value = prompt;
  await nextTick();
  await focusInput();
};

const handleSituationSendMessage = (text) => {
  // 在态势大屏中发送消息：复用主聊天的发送逻辑
  inputMessage.value = text;
  nextTick(() => handleSend());
};

watch(
  () => route.params.id || null,
  async (routeSessionId, previousRouteSessionId) => {
    const nextSessionId = typeof routeSessionId === 'string' ? decodeURIComponent(routeSessionId) : null;
    const wasSessionChat = typeof previousRouteSessionId === 'string';
    const isEnteringBlankChat = !nextSessionId && wasSessionChat;
    if (isEnteringBlankChat) {
      clearNewChatLaunchTimer();
      newChatLaunching.value = false;
      switchingToNewChat.value = true;
    }
    await syncSessionFromRoute(nextSessionId);
    if (isEnteringBlankChat) {
      await nextTick();
      resetScrollPosition();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          switchingToNewChat.value = false;
        });
      });
    }
  },
  { immediate: true }
);

onMounted(() => {
  resetFollowing();
  updateScrollBottomGap();
  scrollToBottom(true);
  loadEntryAgentOptions();
  loadActiveTeam();
  loadRecentSessions(true);
});

onUnmounted(() => {
  clearNewChatLaunchTimer();
  clearLlmRetryState();
  disconnectSessionWS();

  // 不再通知后端停止任务 — Agent 继续在后台执行

  invalidateActiveStream();

});
</script>

<style src="../styles/chat-view.css"></style>
<style>
/* #9: 压缩摘要 - 已移除独立卡片样式，走通用 assistant 渲染路径 */
.user-edit-shell {
  display: flex;
  flex-direction: column;
  gap: 10px;
  transform-origin: top right;
  transition: opacity 220ms ease, transform 220ms ease, filter 220ms ease;
  will-change: transform, opacity;
}
.user-edit-shell.is-editing {
  transform: translateY(-1px);
}
.user-edit-shell.is-submitting {
  opacity: 0.86;
  filter: saturate(0.96);
  transform: translateY(-1px);
}
.user-text {
  transition:
    background-color var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    border-color var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    box-shadow var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    min-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    max-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    opacity var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    transform var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)),
    filter var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1));
  will-change: transform, opacity, min-height, max-height;
}
.user-text.is-editing {
  transform: none;
}
.user-text.is-submitting {
  opacity: 1;
  filter: none;
  transform: none;
}
.user-attachments {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 0;
  transition: opacity 220ms ease, transform 220ms ease, filter 220ms ease;
  will-change: transform, opacity;
}
.user-attachments.is-editing {
  align-items: flex-end;
  margin-bottom: 0;
}
.user-attachments.is-submitting {
  opacity: 1;
  filter: none;
  transform: none;
}
.user-attachments-toolbar {
  display: flex;
  justify-content: flex-end;
  width: min(420px, 100%);
  box-sizing: border-box;
  margin-top: 2px;
  opacity: 0;
  max-height: 0;
  overflow: hidden;
  transform: translateY(-4px);
  pointer-events: none;
  transition: opacity var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)), max-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1)), transform var(--edit-transition-duration, 240ms) var(--edit-transition-ease, cubic-bezier(0.22, 1, 0.36, 1));
}
.user-attachments-toolbar.is-visible {
  opacity: 1;
  max-height: 40px;
  transform: translateY(0);
  pointer-events: auto;
}
.user-attachment-card {
  display: flex;
  align-items: center;
  gap: 12px;
  width: min(420px, 100%);
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-secondary);
  transition: transform 220ms ease, box-shadow 220ms ease, border-color 220ms ease, opacity 220ms ease, filter 220ms ease;
}
.user-attachment-card:hover {
  border-color: var(--color-border-hover);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.08);
}
.btn-editor {
  transition: transform 180ms ease, opacity 180ms ease, box-shadow 180ms ease, filter 180ms ease;
}
.btn-editor:hover:not(:disabled) {
  transform: translateY(-1px);
}
.btn-editor:active:not(:disabled) {
  transform: scale(0.985);
}
.btn-editor:disabled {
  opacity: 0.65;
  cursor: not-allowed;
}
.user-attachment-image {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--color-border);
  flex-shrink: 0;
}
.user-attachment-file-icon {
  width: 56px;
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 600;
  flex-shrink: 0;
}
.user-attachment-info {
  min-width: 0;
  flex: 1;
}
.user-attachment-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.user-attachment-meta {
  margin-top: 4px;
  font-size: 11px;
  color: var(--color-text-muted);
}

.session-meta-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.session-meta-section + .session-meta-section {
  margin-top: 6px;
  padding-top: 8px;
  border-top: 1px solid var(--color-border);
}

.session-meta-section-title {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  font-weight: 600;
}

.session-meta-popover-anchor {
  position: relative;
  flex-shrink: 0;
  z-index: calc(var(--z-sticky, 10) + 4);
}

.session-meta-popover-anchor--inline-end {
  margin-left: auto;
}

.execution-pill--popover {
  width: 20px;
  height: 20px;
  margin-left: 0;
  color: var(--color-text-muted);
}

.execution-pill--popover:hover,
.execution-pill--popover.is-expanded {
  color: var(--color-text-primary);
  opacity: 1;
}

.execution-pill__icon {
  width: 14px;
  height: 14px;
}

.session-meta-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  border-radius: 999px;
  padding: 4px 10px;
  font-size: var(--font-size-xs);
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.session-meta-toggle--icon {
  width: 18px;
  height: 18px;
  padding: 0;
  justify-content: center;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
  line-height: 1;
}

.session-meta-toggle-arrow {
  font-size: 11px;
  color: var(--color-text-muted);
}

.session-meta-toggle:hover,
.session-meta-toggle.is-expanded {
  color: var(--color-text-primary);
  border-color: var(--color-border-hover);
  background: var(--color-bg-tertiary);
}

.session-meta-panel {
  position: absolute;
  left: 0;
  bottom: calc(100% + 14px);
  z-index: 120;
  min-width: 260px;
  max-width: min(420px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  box-shadow: var(--shadow-lg);
}

.session-meta-panel--end {
  left: auto;
  right: 0;
  transform: translateY(-2px);
}

.session-meta-item {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
}

.session-meta-label {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.session-meta-value {
  min-width: 0;
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.session-meta-value--path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.composer-status-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-width: 0;
  flex-wrap: wrap;
}

.execution-pill {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
  transition: opacity 0.2s ease, color 0.2s ease;
}

.execution-pill::before {
  content: '';
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
  opacity: 0.9;
}

.execution-pill--popover::before {
  display: none;
}

.execution-pill.is-running {
  color: var(--color-brand-accent-light);
}

.execution-pill.is-running::before {
  animation: execution-pill-breathe 1.8s ease-in-out infinite;
}

.execution-pill.is-warning {
  color: var(--color-warning);
}

.execution-pill.is-warning::before {
  animation: execution-pill-breathe 1.6s ease-in-out infinite;
}

.execution-pill.is-error {
  color: var(--color-error);
}

.execution-pill.is-error::before {
  animation: execution-pill-breathe 1.35s ease-in-out infinite;
}

.execution-pill.is-success {
  color: var(--color-success);
}

@keyframes execution-pill-breathe {
  0%, 100% {
    opacity: 0.45;
    transform: scale(1);
  }
  50% {
    opacity: 1;
    transform: scale(1.08);
  }
}
/* .context-usage-bar:hover {
  background: var(--color-bg-secondary);
} */

.context-usage-content {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  cursor: pointer;
  padding: 4px;
  margin: -4px;
}

.context-usage-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.compressing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--color-brand-accent-light);
  margin-left: 6px;
}
.compressing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand-accent-light);
  animation: compressing-pulse 1.2s ease-in-out infinite;
}
@keyframes compressing-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

.inline-chart-wrapper {
  margin: 12px 0;
  width: 100%;
}

.artifact-inline-focus {
  border-radius: 10px;
  outline: 1px solid rgba(var(--color-active-rgb), 0.34);
  outline-offset: 4px;
  transition: outline-color 0.2s ease;
}

@media (max-width: 600px) {
  .composer-status-row {
    align-items: center;
  }

  .execution-pill {
    margin-left: 0;
  }
}

@media (max-width: 480px) {
  .context-usage-content {
    flex: 0 0 auto;
  }

  .context-usage-label,
  .compressing-indicator {
    display: none;
  }
}

/* ===== Scroll to Bottom Button ===== */
.scroll-to-bottom-btn {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 12px);
  right: auto;
  transform: translateX(-50%);
  z-index: 1;
  color: var(--color-text-primary);
  cursor: pointer;
  pointer-events: auto;
  transition: transform 0.2s ease, opacity 0.2s ease;
}

.scroll-to-bottom-btn:hover {
  transform: translateX(-50%) translateY(-2px);
}

.scroll-to-bottom-btn:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 3px;
}

.scroll-btn-fade-enter-active,
.scroll-btn-fade-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.scroll-btn-fade-enter-from,
.scroll-btn-fade-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(10px) scale(0.92);
}

@media (max-width: 767px) {
  .scroll-to-bottom-btn {
    bottom: calc(100% + 10px);
    z-index: 1;
  }
}
/* 顶部右侧会话文件/导出按钮：桌面端保留文字，移动端收敛为与主题按钮一致的图标态 */
.top-action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.top-action-btn svg {
  flex-shrink: 0;
}

.top-action-btn:disabled {
  opacity: 0.5;
}

@media (max-width: 767px) {
  .top-action-btn {
    width: 44px;
    min-width: 44px;
    height: 44px;
    padding: 0;
    /* border-radius: 12px; */
    justify-content: center;
    gap: 0;
  }

  .top-action-btn svg {
    width: 20px;
    height: 20px;
  }
}

.stopped-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: var(--radius-full);
  background: var(--color-warning-bg, rgba(250, 173, 20, 0.1));
  color: var(--color-warning, #faad14);
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid rgba(250, 173, 20, 0.2);
  width: fit-content;
}

.stopped-badge svg {
  flex-shrink: 0;
}

.msg-action-btn.btn-execution-tree.active {
  color: var(--color-brand-accent);
  background: rgba(var(--color-brand-accent-rgb), 0.12);
  box-shadow: inset 0 0 0 1px rgba(var(--color-brand-accent-rgb), 0.28);
}

.msg-action-btn.btn-execution-tree:not(.active):hover {
  color: var(--color-brand-accent);
  background: rgba(var(--color-brand-accent-rgb), 0.06);
}

.msg-action-btn.btn-execution-tree.active:hover {
  color: var(--color-brand-accent);
  background: rgba(var(--color-brand-accent-rgb), 0.16);
}

.msg-action-btn.btn-execution-tree:active {
  transform: none;
}

/* 消息查看/编辑模式切换动画 */
.message-view-mode,
.message-edit-mode {
  animation: messageSlideIn 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

</style>
