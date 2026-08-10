<template>
 <div class="chat-page-shell">
    <main id="main-content" tabindex="-1" class="chat-main multi-agent-layout" :class="chatMainClasses">
    <SessionParticipantNav
      v-if="currentSessionId"
      mode="desktop"
      :participants="participants"
      :selected-id="selectedParticipantId"
      :loading="participantsLoading"
      @select="selectParticipant"
      @refresh="loadSessionParticipants(currentSessionId)"
    />
    <div class="chat-conversation-column">
      <SessionParticipantNav
        v-if="currentSessionId"
        mode="mobile"
        :participants="participants"
        :selected-id="selectedParticipantId"
        :loading="participantsLoading"
        @select="selectParticipant"
        @refresh="loadSessionParticipants(currentSessionId)"
      />
      <SessionContextBar
        :current-session-id="currentSessionId || ''"
        :session-title="currentSessionTitle"
        :is-exporting-session="isExportingSession"
        :scrolled="topControlsBarScrolled"
        :goal-state="goalState"
        :task-state="backgroundTaskState"
        :team="currentSessionTeam"
        :entry-agent="pendingEntryAgent"
        :workspace-root="pendingWorkspaceRoot"
        :workspace-display="sessionWorkspaceDisplay"
        :execution-status-text="executionStatusText"
        :show-execution-status="showExecutionPill"
        :execution-observability="runtimeObservability"
        :selected-participant="selectedParticipant"
        @open-mobile-sidebar="openMobileSidebar"
        @export-session="exportCurrentSession"
        @open-file-changes="fileChangesOpen = true"
        @open-runtime-center="openRuntimeCenter"
      />
      <div class="chat-messages-wrapper" ref="messagesRef" @scroll="handleScroll">
        <ChatMessageList
          :messages-loading="messagesLoading"
          :messages="messages"
          :visible-messages="visibleMessages"
          @update:editing-draft="editingDraft = $event"
          @notify="({ message, type }) => showToast(message, type)"
          @citation-click="openCitation"
        >
          <template #empty>
            <ChatEmptyState v-if="isRootParticipant" />
            <ParticipantThreadEmpty v-else :participant="selectedParticipant" />
          </template>
        </ChatMessageList>
      <div
        class="chat-bottom-region"
        :class="{
          'chat-bottom-region--interaction': approvalQueue.length || pendingUserInput,
          'chat-bottom-region--new-chat': !hasMessages,
        }"
      >
        <transition name="scroll-btn-fade">
          <LiquidGlass v-if="isRootParticipant && showScrollToBottomButton" :width="40" :height="40" :radius="999"
            extra-filter="blur(2px) contrast(1.15) brightness(1.06) saturate(1.1)"
            class="scroll-to-bottom-btn" @click="onScrollToBottomClick"
            :title="unreadCount > 0 ? `${unreadCount} 条新消息，滚动到底部` : '滚动到底部'"
            :aria-label="unreadCount > 0 ? `${unreadCount} 条新消息，滚动到底部` : '滚动到底部'">
            <IconChevronDown :size="18" />
          </LiquidGlass>
        </transition>
        <Transition name="chat-surface-swap" mode="out-in">
          <ChatInteractionHost
            v-if="approvalQueue.length || pendingUserInput"
            key="interaction"
            :approval-queue="chatApprovalQueue"
            :approval-submitting-id="approvalSubmittingId"
            :pending-user-input="pendingUserInput"
            :response-allowed="canRespondInteraction"
            @approval-submit="({ approvalId, approved, message }) => submitApproval(approvalId, approved, message, currentSessionId)"
            @user-input-submit="handleUserInputSubmit"
            @user-input-cancel="handleUserInputCancel"
          />
          <ChatComposer
            v-else-if="isRootParticipant"
            key="composer"
            ref="chatComposerRef"
            v-model="inputMessage"
            :attachments="pendingAttachments"
            :can-send="canSendMessage"
            :can-stop="canStopRun"
            :can-resume="canResumeRun"
            :can-attach="canAttachFiles"
            :has-messages="hasMessages"
            :new-chat-launching="newChatLaunching"
            :followup-candidates="pendingFollowupCandidates"
            :session-id="currentSessionId || ''"
            :chat-sdk-client="chatSdkClient"
            :context-usage="contextUsage"
            :context-usage-pct="contextUsagePct"
            :context-usage-class="contextUsageClass"
            :is-compressing="isCompressing"
            :team="currentSessionTeam"
            :team-options="teamOptions"
            :team-loading="teamLoading"
            :entry-agent="pendingEntryAgent"
            :workspace-root="pendingWorkspaceRoot"
            :entry-agent-options="entryAgentOptions"
            :entry-agent-loading="entryAgentLoading"
            @send="handleSend"
            @stop="handleStop"
            @resume="handleResume"
            @open-attachments="() => openSessionFilesDrawer('composer')"
            @remove-attachment="removePendingAttachment"
            @paste-files="handleSessionFileSelect"
            @update:team="setPendingTeam"
            @update:entry-agent="pendingEntryAgent = $event"
            @update:workspace-root="pendingWorkspaceRoot = $event"
            @open-context-drawer="openCtxDrawer"
          />
        </Transition>
      </div>
      </div>
    </div><!-- end .chat-conversation-column -->
    <RuntimeCenterHost
      v-model:open="runtimeCenterOpen"
      :task-state="backgroundTaskState"
      :goal-state="goalState"
    />
    </main>

    <!-- 上下文快照抽屉 -->
    <ContextSnapshotDrawer
      :visible="ctxDrawerVisible"
      :session-id="currentSessionId"
      :selected-llm="ctxDrawerSelectedLlm"
      :chat-sdk-client="chatSdkClient"
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
    <FileChangesPanel
      v-model:open="fileChangesOpen"
      :session-id="currentSessionId || ''"
      :message-seq="currentContextMessage?.seq ?? null"
    />
    <ImageLightbox :open="imageLightbox.open.value" :images="imageLightbox.images.value" :index="imageLightbox.index.value" :current="imageLightbox.current.value" @close="imageLightbox.close" @previous="imageLightbox.previous" @next="imageLightbox.next" />
    <KnowledgeMdViewer v-model:open="showCitationViewer" :file-id="citationFile.file_id" :file-name="citationFile.file_name" :initial-char-start="citationFile.char_start" :initial-heading="citationFile.heading" @citation-click="openCitation" />

    <!-- 文件预览确认对话框 -->
    <FilePreviewConfirmDialog ref="filePreviewDialogRef" />

</div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted, watch, inject, provide, reactive } from 'vue';
import { useRoute } from 'vue-router';
import { useChatSessionController } from '../composables/useChatSessionController';
import { getFrontendChatSdk } from '../composables/chatSdkClient';
import { useSessionAgentClient } from '../composables/useSessionAgentClient';
import { useSessionRuntimeStatus } from '../composables/useSessionRuntimeStatus';
import { useSessionMessages } from '../composables/useSessionMessages';
import { useSessionParticipants } from '../composables/useSessionParticipants.js';
import { useMessageRevision } from '../composables/useMessageRevision';
import { useSessionFilesAttachments } from '../composables/useSessionFilesAttachments';
import { useApprovalQueue } from '../composables/useApprovalQueue';
import { useChatScrolling } from '../composables/useChatScrolling';
import { useLlmRetryState } from '../composables/useLlmRetryState';
import { useChatMessageRuntime } from '../composables/useChatMessageRuntime';
import { useMessageListView } from '../composables/useMessageListView';
import { useRuntimeStatusView } from '../composables/useRuntimeStatusView';
import { normalizeSessionAttachment as normalizeAttachmentUtil } from '../utils/sessionAttachments';
import SessionFilesDrawer from '../components/SessionFilesDrawer.vue';
import ChatComposer from '../components/chat/ChatComposer.vue';
import FileChangesPanel from '../components/agent/FileChangesPanel.vue';
import ImageLightbox from '../components/common/ImageLightbox.vue';
import KnowledgeMdViewer from '../components/knowledge/KnowledgeMdViewer.vue';
import { useImageLightbox } from '../composables/useImageLightbox.js';

import LiquidGlass from '../components/LiquidGlass.vue';
import FilePreviewConfirmDialog from '../components/FilePreviewConfirmDialog.vue';
import ContextSnapshotDrawer from '../components/ContextSnapshotDrawer.vue';
import IconChevronDown from '../components/icons/IconChevronDown.vue';
import { useToast } from '../composables/useToast.js';
import ChatMessageList from '../components/chat/ChatMessageList.vue';
import ChatEmptyState from '../components/chat/ChatEmptyState.vue';
import SessionContextBar from '../components/chat/SessionContextBar.vue';
import SessionParticipantNav from '../components/chat/SessionParticipantNav.vue';
import ParticipantThreadEmpty from '../components/chat/ParticipantThreadEmpty.vue';
import ChatInteractionHost from '../components/chat/ChatInteractionHost.vue';
import RuntimeCenterHost from '../components/chat/RuntimeCenterHost.vue';
import { useSessionBackgroundTasks } from '../composables/useSessionBackgroundTasks.js';
import { useSessionGoal } from '../composables/useSessionGoal.js';
import { useSessionRuntimeCenter } from '../composables/useSessionRuntimeCenter.js';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { useSessionListStore } from '../stores/session-list.js';
import { useLlmStore } from '../stores/llm.js';
import { sessionLoadStrategyRestoresActiveRun } from '@ragsystem/agent-protocol';

// Emits
const route = useRoute();
const shellSidebarControl = inject('shellSidebarControl', null);

const inputMessage = ref('');
const sessionRunStore = useSessionRunStore();
const sessionListStore = useSessionListStore();
const llmStore = useLlmStore();
const chatSdkClient = getFrontendChatSdk();
const {
  messages,
  rootMessages,
  currentSessionId,
  isLoading,
  isCompressing,
  sessionRuntime,
  runtimeObservability,
  contextUsage,
  pendingFollowupCandidates,
  selectedParticipantId,
} = storeToRefs(sessionRunStore);

const isRootParticipant = computed(() => selectedParticipantId.value === 'root');

const currentSessionTitle = computed(() => {
  if (!currentSessionId.value) return '新聊天';
  const session = sessionListStore.getById(currentSessionId.value);
  const storedTitle = String(session?.title || '').trim();
  if (storedTitle && !['New Conversation', '新会话', '新聊天'].includes(storedTitle)) return storedTitle;
  const firstUserMessage = rootMessages.value.find(message => message?.role === 'user' && String(message.content || '').trim());
  const messageTitle = String(firstUserMessage?.content || '').replace(/\s+/g, ' ').trim();
  return messageTitle ? messageTitle.slice(0, 60) : '未命名会话';
});

// 输入草稿持久化：按 sessionId 分片存 localStorage，切会话/刷新后恢复，发送清空
const DRAFT_PREFIX = 'chat-draft:';
const draftKey = computed(() => DRAFT_PREFIX + (currentSessionId.value || '__new__'));
watch(currentSessionId, () => {
  let saved = '';
  try { saved = localStorage.getItem(draftKey.value) || ''; } catch (e) { saved = ''; }
  inputMessage.value = saved;
}, { immediate: true });
watch(inputMessage, (val) => {
  try {
    if (val) localStorage.setItem(draftKey.value, val);
    else localStorage.removeItem(draftKey.value);
  } catch (e) { /* localStorage 不可用时静默 */ }
});
const topControlsBarScrolled = ref(false);
const {
  messagesRef,
  showScrollToBottomButton,
  unreadCount,
  updateScrollBottomGap,
  waitForScrollLayout,
  scrollToBottom,
  resetFollowing,
  resetScrollPosition,
  stickToBottom,
  handleScroll,
  onScrollToBottomClick,
} = useChatScrolling({ messages, topControlsBarScrolled });

const sessionFilesDrawerVisible = ref(false);
const fileChangesOpen = ref(false);
const imageLightbox = useImageLightbox();
const showCitationViewer = ref(false);
const citationFile = reactive({ file_id: '', file_name: '', char_start: undefined, heading: '' });
function openCitation(citation) { citationFile.file_id = citation?.file_id || ''; citationFile.file_name = citation?.file_name || ''; citationFile.char_start = Number.isFinite(citation?.char_start) ? citation.char_start : undefined; citationFile.heading = citation?.heading || ''; showCitationViewer.value = Boolean(citationFile.file_id); }
function openAttachmentImages(attachments, selected) { const items = (attachments || []).filter(item => item && (item.mime?.startsWith('image/') || /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(item.original_name || item.stored_name || ''))).map(item => ({ src: getAttachmentPreviewUrl(item), alt: item.original_name || item.stored_name || '图片', source: item })); const index = Math.max(0, items.findIndex(item => item.source === selected)); imageLightbox.show(items, index); }
const sessionFilesDrawerTarget = ref('composer');
const chatComposerRef = ref(null);
const filePreviewDialogRef = ref(null);
const toast = useToast();
const ctxDrawerVisible = ref(false);
const ctxDrawerSelectedLlm = ref('');
const newChatLaunching = ref(false);
const switchingToNewChat = ref(false);
const restoringSessionScroll = ref(false);
let newChatLaunchTimer = null;
let sessionScrollRestoreTimer = null;
let pendingSessionScrollRestores = 0;

function getCurrentSelectedLlm() {
  return llmStore.selectedLLM || '';
}

function openCtxDrawer() {
  ctxDrawerSelectedLlm.value = getCurrentSelectedLlm();
  ctxDrawerVisible.value = true;
}

const { activeRun: _activeRun, resetActiveRun, clearFollowupCandidates } = sessionRunStore;

// 被下方 composable deps 引用的工具函数前置定义，消除延迟闭包。
// 仅被 view 内部引用的辅助函数（openMobileSidebar/clearNewChatLaunchTimer 等）保留原位置。
const showToast = (message, actionOrType = null, actionLabel = '重试') => {
  let type = 'error';
  let action = null;
  if (typeof actionOrType === 'string') {
    type = actionOrType;
  } else if (typeof actionOrType === 'function') {
    action = actionOrType;
  }
  toast.show(message, action || type, actionLabel);
};

const {
  participants,
  participantsLoading,
  selectedParticipant,
  loadSessionParticipants,
} = useSessionParticipants({ chatSdkClient, showToast });

const focusInput = async () => {
  if (chatComposerRef.value?.focus) {
    await chatComposerRef.value.focus();
  }
};

const clearSessionScrollRestoreTimer = () => {
  if (!sessionScrollRestoreTimer) return;
  window.clearTimeout(sessionScrollRestoreTimer);
  sessionScrollRestoreTimer = null;
};

const beginInitialScrollRestore = () => {
  clearSessionScrollRestoreTimer();
  pendingSessionScrollRestores += 1;
  restoringSessionScroll.value = true;
};

const endInitialScrollRestore = () => {
  pendingSessionScrollRestores = Math.max(0, pendingSessionScrollRestores - 1);
  if (pendingSessionScrollRestores > 0) return;
  clearSessionScrollRestoreTimer();
  sessionScrollRestoreTimer = window.setTimeout(() => {
    restoringSessionScroll.value = false;
    sessionScrollRestoreTimer = null;
  }, 0);
};

// ── Composables ─────────────────────────────────────────────────────────
// 仍存在少量前向循环引用（如 Connection↔RunStream 的 onMessage/finalize、
// Revision↔Send 的 handleSend/resetEditingState）以闭包延迟解析，其余直接传引用。

const {
  llmRetryState,
  formatRetryCountdown,
  setLlmRetryState,
  clearLlmRetryState,
} = useLlmRetryState();

const {
  createAssistantMessage,
  normalizeAssistantExecutionState,
  applyEnvelopeToMessage,
  createAssistantMessageFromHistory,
  isRootEvent,
  isMasterEvent,
  findRunningExecutionAgentByAgentId,
  ensureExecutionStepsLoaded,
} = useChatMessageRuntime({
  activeRun: _activeRun,
  chatSdkClient,
  selectedParticipantId,
});

const {
  messagesLoading, cacheMessages, deleteMessageCache,
  loadSessionMessages, mergeMessageIdsFromServer,
} = useSessionMessages({
  normalizeAssistantExecutionState,
  createAssistantMessageFromHistory,
  normalizeAttachment: normalizeAttachmentUtil,
  scrollToBottom,
  waitForScrollLayout,
  focusInput,
  loadContextSnapshot: (...a) => loadContextSnapshot(...a),
  chatSdkClient,
  showToast,
  invalidateActiveStream: () => invalidateActiveStream(),
  shouldReplayActiveRun: (sessionId) => sessionId === currentSessionId.value
    && Boolean(sessionRuntime.value?.active_run)
    && sessionLoadStrategyRestoresActiveRun(sessionRuntime.value.load_strategy),
  replayActiveRun: (sessionId) => reconnectSessionWS(sessionId, { historySnapshot: true }),
  beginInitialScrollRestore,
  endInitialScrollRestore,
});

const selectParticipant = async (participantId) => {
  const next = typeof participantId === 'string' && participantId.trim() ? participantId.trim() : 'root';
  if (!currentSessionId.value || !participants.value.some(item => item?.participant_id === next)) return;
  if (!sessionRunStore.setSelectedParticipant(next)) return;
  await loadSessionMessages(currentSessionId.value, {
    participantId: next,
    preserveStream: true,
  });
  await nextTick();
  await scrollToBottom(true, 'auto');
};

const { loadContextSnapshot, clearExecutionState: _clearExecutionStateBase } = useSessionRuntimeStatus({
  clearLlmRetryState,
  chatSdkClient,
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
  sessionRuntime,
  contextUsage,
});

const goalState = reactive(useSessionGoal(currentSessionId));
const backgroundTaskState = reactive(useSessionBackgroundTasks(currentSessionId));
const {
  isOpen: runtimeCenterOpen,
  open: openRuntimeCenter,
  close: closeRuntimeCenter,
} = useSessionRuntimeCenter();
const currentContextMessage = computed(() => {
  if (_activeRun.assistantMsgIndex >= 0) {
    return messages.value[_activeRun.assistantMsgIndex] || null;
  }
  for (let index = messages.value.length - 1; index >= 0; index -= 1) {
    if (messages.value[index]?.role === 'assistant') return messages.value[index];
  }
  return null;
});

const {
  approvalQueue,
  approvalSubmittingId,
  pendingUserInput,
  enqueueApproval,
  handleApprovalResolved,
  submitApproval,
  resetApprovalState,
  showUserInput,
  handleUserInputSubmit,
  handleUserInputCancel,
  handleUserInputResolved,
} = useApprovalQueue({
  currentSessionId,
  filePreviewDialogRef,
  respondInteraction: (id, response) => respondInteraction(id, response),
  canRespondInteraction: () => sessionRunStore.allowsRuntimeAction('respond_interaction'),
  showToast,
});

const hasMessages = computed(() => messages.value.length > 0);
// 大文件读取确认使用专用预览对话框；阻止其后的审批越过队列提前显示。
const chatApprovalQueue = computed(() => {
  const firstFilePreviewIndex = approvalQueue.value.findIndex(
    approval => approval?.approval_type === 'file_read_confirm',
  );
  return firstFilePreviewIndex < 0
    ? approvalQueue.value
    : approvalQueue.value.slice(0, firstFilePreviewIndex);
});
const runtimeActions = computed(() => new Set(sessionRuntime.value?.allowed_actions || []));
const canSendMessage = computed(() => !currentSessionId.value
  || runtimeActions.value.has('send_message')
  || runtimeActions.value.has('send_followup'));
const canStopRun = computed(() => runtimeActions.value.has('stop_run'));
const canResumeRun = computed(() => runtimeActions.value.has('resume_run'));
const canRespondInteraction = computed(() => runtimeActions.value.has('respond_interaction'));
const canAttachFiles = computed(() => !currentSessionId.value || runtimeActions.value.has('send_message'));
// Layout phase (has-messages/workbench) + transient motion flags on .chat-main,
// consolidated to a single source of truth. is-new-chat dropped (== !has-messages).
const chatMainClasses = computed(() => ({
  'has-messages': hasMessages.value,
  'is-launching-chat': newChatLaunching.value,
  'is-switching-to-new-chat': switchingToNewChat.value,
  'is-restoring-session-scroll': restoringSessionScroll.value,
  'multi-agent-active': Boolean(currentSessionId.value),
}));

const {
  invalidateActiveStream,
  connectSessionWS, reconnectSessionWS, disconnectSessionWS, initializeSessionEventCursor,
  resetStreamSessionState,
  send: sendSessionMessage,
  stop: handleStop,
  resume: handleResume,
  respondInteraction,
  waitForSessionRuntime,
} = useSessionAgentClient({
  chatSdkClient,
  createAssistantMessage,
  cacheMessages,
  deleteMessageCache,
  loadSessionMessages,
  mergeMessageIdsFromServer,
  updateRecentSession: (...a) => updateRecentSession(...a),
  applyEnvelopeToMessage,
  findRunningExecutionAgentByAgentId,
  isRootEvent,
  isMasterEvent,
  enqueueApproval,
  handleApprovalResolved,
  showUserInput,
  resetApprovalState,
  handleUserInputResolved,
  clearLlmRetryState,
  setLlmRetryState,
  inputMessage,
  get pendingAttachments() { return pendingAttachments; },
  getCurrentSelectedLlm,
  ensureSession: (...a) => ensureSession(...a),
  materializeAttachmentsForSend: (...a) => materializeAttachmentsForSend(...a),
  clearComposerAttachments: () => clearComposerAttachments(),
  resetEditingState: (...a) => resetEditingState(...a),
  clearEditingAttachments: () => clearEditingAttachments(),
  stickToBottom,
  scrollToBottom,
  showToast,
  handleBackgroundTaskLifecycle: backgroundTaskState.handleLifecycleEvent,
});
const {
  sessionFiles,
  pendingAttachments,
  sessionFilesLoading,
  uploadingSessionFiles,
  deletingSessionFileId,
  normalizeAttachment,
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
  showToast,
  chatSdkClient,
});

const {
  editingMessage,
  editingDraft,
  editingAttachmentsDraft,
  editingSubmitting,
  canReviseMessage,
  startEditMessage,
  resetEditingState,
  cancelEdit,
  confirmEditAndResend,
  rollbackAndRetry,
} = useMessageRevision({
  sessionFilesDrawerVisible,
  sessionFilesDrawerTarget,
  normalizeAttachment,
  showToast,
  cacheMessages,
  activeRun: _activeRun,
  materializeAttachmentsForSend,
  getCurrentSelectedLlm,
  reloadSessionMessages: (sessionId) => loadSessionMessages(sessionId),
  stickToBottom,
  chatSdkClient,
});

// ── Workspace 文件导航 ─────────────────────────────────────────

// clearExecutionState 需要额外清理 view 级状态
const clearExecutionState = (opts) => {
  _clearExecutionStateBase(opts);
  resetStreamSessionState();
  resetActiveRun();
  clearFollowupCandidates();
  isCompressing.value = false;
};

const {
  currentSessionTeam,
  teamOptions,
  teamLoading,
  pendingWorkspaceRoot,
  pendingEntryAgent,
  sessionWorkspaceDisplay,
  entryAgentOptions,
  entryAgentLoading,
  isExportingSession,
  loadEntryAgentOptions,
  loadActiveTeam,
  setPendingTeam,
  exportCurrentSession,
  updateRecentSession,
  syncSessionFromRoute,
  ensureSession,
} = useChatSessionController({
  sessionFiles,
  sessionFilesDrawerVisible,
  sessionFilesDrawerTarget,
  loadSessionMessages,
  loadSessionFiles,
  connectSessionWS,
  disconnectSessionWS,
  invalidateActiveStream,
  initializeSessionEventCursor,
  clearExecutionState: (...a) => clearExecutionState(...a),
  waitForSessionRuntime,
  clearComposerAttachments,
  showToast,
  chatSdkClient,
  loadSessionParticipants,
});

const {
  messageKey,
  visibleMessages,
  copyMessage,
} = useMessageListView({
  messages,
  showToast,
});

const messageContext = reactive({
  messageKey,
  getAssistantRuntimeStatusText,
  getAttachmentPreviewUrl,
  openAttachmentImages,
  confirmEditAndResend,
  cancelEdit,
  openSessionFilesDrawer,
  removeEditingAttachment,
  canReviseMessage,
  startEditMessage,
  copyMessage,
  ensureExecutionStepsLoaded,
  rollbackAndRetry,
  currentSessionId,
  isLoading,
  editingMessage,
  editingDraft,
  editingAttachmentsDraft,
  editingSubmitting,
});
provide('messageContext', messageContext);

// ── end Composables ─────────────────────────────────────────────────────

// 移动端状态

// 打开移动端侧边栏
const openMobileSidebar = () => {
  shellSidebarControl?.openMobileSidebar?.();
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

watch(
  () => route.params.id || null,
  async (routeSessionId, previousRouteSessionId) => {
    if (import.meta.env.DEV && route.query?.__smoke === 'empty') {
      disconnectSessionWS();
      invalidateActiveStream();
      clearExecutionState();
      currentSessionId.value = null;
      messages.value = [];
      contextUsage.value = null;
      await nextTick();
      resetScrollPosition(false);
      return;
    }

    if (import.meta.env.DEV && route.query?.__smoke === 'artifact') {
      const { createSmokeArtifactMessages } = await import('../utils/smokeFixtures');
      disconnectSessionWS();
      invalidateActiveStream();
      clearExecutionState();
      currentSessionId.value = 'smoke-artifact-session';
      messages.value = createSmokeArtifactMessages();
      contextUsage.value = { used: 1840, max: 8192 };
      await nextTick();
      scrollToBottom(true);
      return;
    }

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
      resetScrollPosition(false);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          switchingToNewChat.value = false;
        });
      });
    }
  },
  { immediate: true }
);

watch(
  () => _activeRun.active || isLoading.value,
  (active, wasActive) => {
    if (wasActive && !active) goalState.loadGoal({ silent: true });
  },
);

watch(currentSessionId, () => {
  closeRuntimeCenter();
});

onMounted(() => {
  resetFollowing();
  updateScrollBottomGap();
  if (route.params.id) scrollToBottom(true);
  else resetScrollPosition(false);
  (async () => {
    await loadActiveTeam();
    // 已有 session 不展示启动设置，无需拉 entry agent 列表（也减少竞态面）
    if (!route.params.id) {
      await loadEntryAgentOptions(currentSessionTeam.value);
    }
  })();
});

onUnmounted(() => {
  clearNewChatLaunchTimer();
  clearSessionScrollRestoreTimer();
  pendingSessionScrollRestores = 0;
  clearLlmRetryState();
  chatSdkClient.disconnect();
  // 不再通知后端停止任务 — Agent 继续在后台执行

  invalidateActiveStream();

});
</script>

<style src="../styles/chat-view.css"></style>
<style>
.chat-surface-swap-enter-active,
.chat-surface-swap-leave-active {
  transition:
    opacity 180ms ease,
    transform 220ms var(--ease-out-expo),
    filter 180ms ease;
}

.chat-surface-swap-enter-from {
  opacity: 0;
  filter: blur(2px);
  transform: translateY(10px) scale(0.99);
}

.chat-surface-swap-leave-to {
  opacity: 0;
  filter: blur(1.5px);
  transform: translateY(6px) scale(0.995);
}

@media (prefers-reduced-motion: reduce) {
  .chat-surface-swap-enter-active,
  .chat-surface-swap-leave-active {
    transition-duration: 1ms;
  }
}

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
    background-color var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)),
    border-color var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)),
    box-shadow var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)),
    min-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)),
    max-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)),
    opacity var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)),
    transform var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)),
    filter var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo));
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
  transition: opacity var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)), max-height var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo)), transform var(--edit-transition-duration, 240ms) var(--edit-transition-ease, var(--ease-out-expo));
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

.inline-chart-wrapper {
  margin: 12px 0;
  width: 100%;
}

.file-inline-focus {
  border-radius: 10px;
  outline: 1px solid rgba(var(--color-active-rgb), 0.34);
  outline-offset: 4px;
  transition: outline-color 0.2s ease;
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

/* 消息查看/编辑模式切换动画 */
.message-view-mode,
.message-edit-mode {
  animation: messageSlideIn 0.3s var(--ease-material);
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
