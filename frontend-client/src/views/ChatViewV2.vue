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
          :tail-active="pendingImageSendState.active"
          @update:editing-draft="editingDraft = $event"
          @notify="({ message, type }) => showToast(message, type)"
          @citation-click="openCitation"
        >
          <template #empty>
            <ChatEmptyState v-if="isRootParticipant" />
            <ParticipantThreadEmpty v-else :participant="selectedParticipant" />
          </template>
          <template #tail>
            <Transition name="pending-image-fade">
              <PendingImageMessage v-if="pendingImageSendState.active" />
            </Transition>
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
            :image-recognition-pending="imageRecognitionPending"
            :image-recognition-progress="imageRecognitionProgress"
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
import { useChatTransient } from '../composables/useChatTransient.js';
import { useLlmRetryState } from '../composables/useLlmRetryState';
import { useChatMessageRuntime } from '../composables/useChatMessageRuntime';
import { useMessageListView } from '../composables/useMessageListView';
import { useRuntimeStatusView } from '../composables/useRuntimeStatusView';
import { normalizeSessionAttachment as normalizeAttachmentUtil } from '../utils/sessionAttachments';
import { getUserDisplayText } from '../utils/messageContentParts';
import SessionFilesDrawer from '../components/SessionFilesDrawer.vue';
import ChatComposer from '../components/chat/ChatComposer.vue';
import PendingImageMessage from '../components/chat/PendingImageMessage.vue';
import FileChangesPanel from '../components/agent/FileChangesPanel.vue';
import ImageLightbox from '../components/common/ImageLightbox.vue';
import KnowledgeMdViewer from '../components/knowledge/KnowledgeMdViewer.vue';
import { useImageLightbox } from '../composables/useImageLightbox.js';
import {
  imageDescribeActive,
  imageDescribeProgress,
  pluginEventState,
  resetImageDescribe,
  resetPluginEventsState,
} from '../composables/usePluginEvents.js';
import {
  capturePendingImageSend,
  clearPendingImageSend,
  pendingImageSendState,
} from '../composables/usePendingImageSend.js';

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
import { useThinkingStore } from '../stores/thinking.js';
import { sessionLoadStrategyRestoresActiveRun } from '@ragsystem/agent-protocol';

// Emits
const route = useRoute();
const shellSidebarControl = inject('shellSidebarControl', null);

const inputMessage = ref('');
const sessionRunStore = useSessionRunStore();
const sessionListStore = useSessionListStore();
const llmStore = useLlmStore();
const thinkingStore = useThinkingStore();
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
  pendingCommands,
  selectedParticipantId,
} = storeToRefs(sessionRunStore);

const isRootParticipant = computed(() => selectedParticipantId.value === 'root');

const currentSessionTitle = computed(() => {
  if (!currentSessionId.value) return '新聊天';
  const session = sessionListStore.getById(currentSessionId.value);
  const storedTitle = String(session?.title || '').trim();
  if (storedTitle && !['New Conversation', '新会话', '新聊天'].includes(storedTitle)) return storedTitle;
  const firstUserMessage = rootMessages.value.find(message => message?.role === 'user' && getUserDisplayText(message));
  const messageTitle = getUserDisplayText(firstUserMessage).replace(/\s+/g, ' ').trim();
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
// 图片识别提示完全由后端 plugin_event 驱动（image-tools 的 describe started/progress/completed），
// 取代此前"带图发送即盲显 + 超时清除"的启发式：视觉辅助未启用时不再误显示。
// 带图发送的识别进度由消息列表底部的幽灵气泡（PendingImageMessage）承载；
// composer 提示条只在无活跃快照时显示（run 内 view_image 等场景），避免双重提示。
const imageRecognitionPending = computed(() => imageDescribeActive.value && !pendingImageSendState.active);
const imageRecognitionProgress = imageDescribeProgress;
const toast = useToast();
const ctxDrawerVisible = ref(false);
const ctxDrawerSelectedLlm = ref('');
const {
  newChatLaunching,
  switchingToNewChat,
  restoringSessionScroll,
  beginNewChatLaunch,
  finishNewChatLaunchSoon,
  startSwitchToNewChat,
  finishSwitchToNewChat,
  beginInitialScrollRestore,
  endInitialScrollRestore,
  resetChatTransient,
} = useChatTransient();

function getCurrentSelectedLlm() {
  return llmStore.selectedLLM || '';
}

function getCurrentThinkingLevel() {
  return thinkingStore.thinkingLevel || '';
}

function openCtxDrawer() {
  ctxDrawerSelectedLlm.value = getCurrentSelectedLlm();
  ctxDrawerVisible.value = true;
}

const { activeRun: _activeRun, resetActiveRun } = sessionRunStore;

// 被下方 composable deps 引用的工具函数前置定义，消除延迟闭包。
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

// 幽灵气泡（带图发送待落库）视为对话已开始：composer 立即沉底进入会话布局，
// 不再停留居中启动态（否则新聊天首发带图时气泡在上、输入框悬在中间，视觉割裂）。
// 发送失败/快照清理后自动回到启动态。
const hasMessages = computed(() => messages.value.length > 0 || pendingImageSendState.active);
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
const canSendMessage = computed(() => {
  if (runtimeActions.value.has('send_followup')) return true;
  if (pendingCommands.value.length > 0) return false;
  return !currentSessionId.value || runtimeActions.value.has('send_message');
});
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
  getCurrentThinkingLevel,
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
  getCurrentThinkingLevel,
  deleteMessageCache,
  reloadSessionMessages: (sessionId, options) => loadSessionMessages(sessionId, options),
  reloadSessionParticipants: (sessionId, options) => loadSessionParticipants(sessionId, options),
  stickToBottom,
  chatSdkClient,
});

// ── Workspace 文件导航 ─────────────────────────────────────────

// clearExecutionState 需要额外清理 view 级状态
const clearExecutionState = (opts) => {
  _clearExecutionStateBase(opts);
  resetStreamSessionState();
  resetActiveRun();
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

const handleSend = async (payload = null) => {
  const startsFromNewChat = messages.value.length === 0 && !currentSessionId.value;
  if (startsFromNewChat) {
    beginNewChatLaunch();
  }

  // 发送前捕获带图消息快照（消息列表底部幽灵气泡）：取值优先级与 sendNow 保持一致。
  // 无图片附件时 capture 内部直接返回 false，不影响现有状态。
  const capturedImageSnapshot = capturePendingImageSend({
    content: (typeof payload?.content === 'string' ? payload.content : inputMessage.value).trim(),
    attachments: Array.isArray(payload?.attachments) ? payload.attachments : pendingAttachments.value,
    getAttachmentPreviewUrl,
  });

  try {
    const started = await sendSessionMessage(payload);
    if (!started) {
      // 发送失败（会话创建/附件准备/启动失败等）：消息不会落库，清理可能已开始的识别提示。
      resetImageDescribe();
      if (capturedImageSnapshot) clearPendingImageSend();
    } else if (capturedImageSnapshot) {
      // 幽灵气泡上屏后跟随到消息流底部。
      await nextTick();
      scrollToBottom(true);
    }
  } finally {
    if (startsFromNewChat) {
      finishNewChatLaunchSoon(messages.value.length > 0 ? 620 : 220);
    }
  }
};

// 图片识别提示：新用户消息出现（持久化完成）即清除（completed 帧丢失时的双保险）。
watch(
  () => messages.value.filter(message => message?.role === 'user' && !message.metadata?.agent_message).length,
  (count, previousCount) => {
    if (count <= previousCount) return;
    if (imageDescribeActive.value) {
      resetImageDescribe();
    }
    // 消息落库：幽灵气泡由正式消息无缝替换。
    if (pendingImageSendState.active) {
      clearPendingImageSend();
    }
  },
);

// 图片全部识别失败时给出提示（部分失败不打扰——主模型为视觉模型时仍可直接看图）。
watch(
  () => pluginEventState.imageDescribe.lastOutcome,
  outcome => {
    if (outcome && outcome.total > 0 && outcome.failed > 0 && outcome.described === 0) {
      showToast('图片识别失败，模型可能无法理解图片内容', 'warning');
    }
  },
);

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

    if (import.meta.env.DEV && route.query?.__smoke === 'pending-image') {
      const { createSmokePendingImageMessages, armSmokePendingImageSend } = await import('../utils/smokeFixtures');
      disconnectSessionWS();
      invalidateActiveStream();
      clearExecutionState();
      currentSessionId.value = 'smoke-pending-image-session';
      messages.value = createSmokePendingImageMessages();
      contextUsage.value = { used: 1840, max: 8192 };
      await nextTick();
      // 幽灵气泡冒烟：?__phase=sending|recognizing|done 控制注入的识别阶段
      await armSmokePendingImageSend(String(route.query?.__phase || 'recognizing'));
      await nextTick();
      scrollToBottom(true);
      return;
    }

    if (import.meta.env.DEV && route.query?.__smoke === 'pending-image-newchat') {
      const { armSmokePendingImageSend } = await import('../utils/smokeFixtures');
      disconnectSessionWS();
      invalidateActiveStream();
      clearExecutionState();
      // 保持草稿态（无会话、无消息）：验证新聊天首发带图的幽灵气泡（消息流尾部挂点 + 居中 composer 布局）。
      currentSessionId.value = null;
      messages.value = [];
      contextUsage.value = null;
      await nextTick();
      resetScrollPosition(false);
      await armSmokePendingImageSend(String(route.query?.__phase || 'recognizing'));
      await nextTick();
      scrollToBottom(true);
      return;
    }

    const nextSessionId = typeof routeSessionId === 'string' ? decodeURIComponent(routeSessionId) : null;
    const wasSessionChat = typeof previousRouteSessionId === 'string';
    const isEnteringBlankChat = !nextSessionId && wasSessionChat;
    if (isEnteringBlankChat) {
      startSwitchToNewChat();
    }
    await syncSessionFromRoute(nextSessionId);
    if (isEnteringBlankChat) {
      await nextTick();
      resetScrollPosition(false);
      finishSwitchToNewChat();
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

watch(currentSessionId, (nextSessionId, previousSessionId) => {
  closeRuntimeCenter();
  // 草稿会话落实（null → 新 id，ensureSession 回填）是本次发送的延续而非切换：
  // 幽灵气泡快照与图片识别状态必须保留到消息落库。
  if (!previousSessionId && nextSessionId) return;
  // 会话切换：清空插件事件状态（进行中的图片识别提示随之收尾）。
  resetPluginEventsState();
  // 幽灵气泡快照（含自有的 object URLs）一并清理。
  clearPendingImageSend();
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
  resetChatTransient();
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

/* 带图发送的幽灵气泡（待落库 pending 消息）进入过渡：仅淡入，离开即被正式消息替换 */
.pending-image-fade-enter-active {
  transition: opacity 180ms ease, transform 220ms var(--ease-out-expo);
}
.pending-image-fade-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
@media (prefers-reduced-motion: reduce) {
  .pending-image-fade-enter-active {
    transition-duration: 1ms;
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
