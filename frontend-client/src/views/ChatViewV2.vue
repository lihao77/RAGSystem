<template>
 <div class="chat-page-shell">
    <main id="main-content" tabindex="-1" class="chat-main" :class="chatMainClasses">
    <div class="chat-conversation-column">
      <SessionContextBar
        :current-session-id="currentSessionId || ''"
        :session-title="currentSessionTitle"
        :is-exporting-session="isExportingSession"
        :scrolled="topControlsBarScrolled"
        @open-mobile-sidebar="openMobileSidebar"
        @export-session="exportCurrentSession"
        @open-file-changes="fileChangesOpen = true"
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
            <ChatEmptyState @select-prompt="applyNewChatSuggestion">
              <template #setup>
                <TaskLauncher
                  v-model:entry-agent="pendingEntryAgent"
                  v-model:workspace-root="pendingWorkspaceRoot"
                  :entry-agent-options="entryAgentOptions"
                  :entry-agent-loading="entryAgentLoading"
                  :normalize-workspace-root-input="normalizeWorkspaceRootInput"
                />
              </template>
            </ChatEmptyState>
          </template>
        </ChatMessageList>
      </div>
      <div class="bottom-dock" :class="{ 'bottom-dock--new-chat': !hasMessages, 'bottom-dock--launching': newChatLaunching && hasMessages }">
         <transition name="scroll-btn-fade">
            <LiquidGlass v-if="showScrollToBottomButton" :width="40" :height="40" :radius="999"
              extra-filter="blur(2px) contrast(1.15) brightness(1.06) saturate(1.1)"
              class="scroll-to-bottom-btn" @click="onScrollToBottomClick"
              :title="unreadCount > 0 ? `${unreadCount} 条新消息，滚动到底部` : '滚动到底部'"
              :aria-label="unreadCount > 0 ? `${unreadCount} 条新消息，滚动到底部` : '滚动到底部'">
              <IconChevronDown :size="18" />
              <span v-if="unreadCount > 0" class="scroll-unread-badge">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
            </LiquidGlass>
          </transition>
          <div class="input-area-wrapper">
          <TransitionGroup
            v-if="pendingFollowupCandidates.length"
            name="followup-candidate"
            tag="div"
            class="followup-candidate-area"
            aria-live="polite"
          >
            <div
              v-for="candidate in pendingFollowupCandidates"
              :key="candidate.metadata?.request_id"
              class="followup-candidate"
              :class="{ 'is-failed': candidate.metadata?.persistence_status === 'failed' }"
            >
              <span class="followup-candidate-state">
                {{ candidate.metadata?.persistence_status === 'failed' ? '发送失败' : '待确认' }}
              </span>
              <span class="followup-candidate-content">{{ candidate.content }}</span>
            </div>
          </TransitionGroup>
          <GoalControl
            v-if="currentSessionId"
            :session-id="currentSessionId"
            :run-active="_activeRun.active || isLoading"
          />
          <ChatInput
            ref="chatInputRef"
            v-model="inputMessage"
            :attachments="pendingAttachments"
            :isLoading="isLoading"
            :can-send-while-loading="_activeRun.active"
            @send="handleSend"
            @stop="handleStop"
            @openAttachments="() => openSessionFilesDrawer('composer')"
            @removeAttachment="removePendingAttachment"
            @pasteFiles="handleSessionFileSelect"
          >
            <template #footerMeta>
              <div class="composer-run-controls" role="group" aria-label="本次发送设置">
                <LLMSelector presentation="composer" />
                <PermissionModeSelector v-if="currentSessionId" :session-id="currentSessionId" />
              </div>
            </template>
            <template #rightActions>
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
    </div><!-- end .chat-conversation-column -->
    <ApprovalQueueHost
      ref="approvalQueueHostRef"
      :show-work-panel="visibleWorkPanel"
      :disable-transition="switchingToNewChat"
      :active-run="_activeRun"
      :current-message="currentRunMessage"
      :injections-by-run-id="injectionsByRunId"
      :message-key="selectedWorkPanelMessageKey"
     :approval-queue="approvalQueue"
      :approval-submitting-id="approvalSubmittingId"
      :pending-user-input="pendingUserInput"
      :context-usage="contextUsage"
      :session-id="currentSessionId || ''"
      @approval-submit="({ approvalId, approved, message }) => submitApproval(approvalId, approved, message, currentSessionId)"
      @user-input-submit="handleWorkPanelUserInputSubmit"
      @user-input-cancel="handleWorkPanelUserInputCancel"
      @artifact-select="handleArtifactSelect"
      @file-changes="fileChangesOpen = true"
    />
    </main>

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
    <FileChangesPanel
      v-model:open="fileChangesOpen"
      :session-id="currentSessionId || ''"
      :message-seq="currentRunMessage?.seq ?? null"
    />
    <ImageLightbox :open="imageLightbox.open.value" :images="imageLightbox.images.value" :index="imageLightbox.index.value" :current="imageLightbox.current.value" @close="imageLightbox.close" @previous="imageLightbox.previous" @next="imageLightbox.next" />
    <KnowledgeMdViewer v-model:open="showCitationViewer" :file-id="citationFile.file_id" :file-name="citationFile.file_name" :initial-char-start="citationFile.char_start" :initial-heading="citationFile.heading" @citation-click="openCitation" />

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
import { ref, computed, defineAsyncComponent, nextTick, onMounted, onUnmounted, watch, inject, provide, reactive } from 'vue';
import { useRoute } from 'vue-router';
import { shouldRefreshSessionMessagesAfterResume, shouldRunResumeRecoveryWatchdog } from '../utils/sessionSocket';
import { useChatSessionController } from '../composables/useChatSessionController';
import { useSessionAgentClient } from '../composables/useSessionAgentClient';
import { useSessionTaskStatus } from '../composables/useSessionTaskStatus';
import { useSessionMessages } from '../composables/useSessionMessages';
import { useMessageRevision } from '../composables/useMessageRevision';
import { useSessionFilesAttachments } from '../composables/useSessionFilesAttachments';
import { useApprovalQueue } from '../composables/useApprovalQueue';
import { useChatScrolling } from '../composables/useChatScrolling';
import { useMessageArtifacts } from '../composables/useMessageArtifacts';
import { useLlmRetryState } from '../composables/useLlmRetryState';
import { useChatMessageRuntime } from '../composables/useChatMessageRuntime';
import { useMessageListView } from '../composables/useMessageListView';
import { useRuntimeStatusView } from '../composables/useRuntimeStatusView';
import { normalizeSessionAttachment as normalizeAttachmentUtil } from '../utils/sessionAttachments';
import ChatInput from '../components/ChatInput.vue';
import LLMSelector from '../components/LLMSelector.vue';
import PermissionModeSelector from '../components/PermissionModeSelector.vue';
import SessionFilesDrawer from '../components/SessionFilesDrawer.vue';
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
import SessionContextInfoButton from '../components/chat/SessionContextInfoButton.vue';
import ApprovalQueueHost from '../components/chat/ApprovalQueueHost.vue';
import TaskLauncher from '../components/chat/TaskLauncher.vue';
import GoalControl from '../components/chat/GoalControl.vue';
import { useWorkbenchLayout } from '../composables/useWorkbenchLayout';
import { storeToRefs } from 'pinia';
import { useSessionRunStore } from '../stores/session-run.js';
import { useSessionListStore } from '../stores/session-list.js';
import { useLlmStore } from '../stores/llm.js';

const SituationScreen = defineAsyncComponent(() => import('../components/SituationScreen.vue'));

// Emits
const route = useRoute();
const shellSidebarControl = inject('shellSidebarControl', null);

const inputMessage = ref('');
const sessionRunStore = useSessionRunStore();
const sessionListStore = useSessionListStore();
const llmStore = useLlmStore();
const {
  messages,
  currentSessionId,
  isLoading,
  isCompressing,
  sessionTaskInfo,
  sessionExecutionObservability,
  contextUsage,
  pendingFollowupCandidates,
} = storeToRefs(sessionRunStore);

const currentSessionTitle = computed(() => {
  if (!currentSessionId.value) return '新聊天';
  const session = sessionListStore.getById(currentSessionId.value);
  const storedTitle = String(session?.title || '').trim();
  if (storedTitle && !['New Conversation', '新会话', '新聊天'].includes(storedTitle)) return storedTitle;
  const firstUserMessage = messages.value.find(message => message?.role === 'user' && String(message.content || '').trim());
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
const chatInputRef = ref(null);
const approvalQueueHostRef = ref(null);
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

const focusInput = async () => {
  if (chatInputRef.value?.focus) {
    await chatInputRef.value.focus();
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
  toggleExecutionView,
  createAssistantMessageFromHistory,
  isRootEvent,
  isMasterEvent,
  findRunningExecutionAgentByAgentId,
  selectedWorkPanelMessageKey,
  getWorkPanelMessageKey,
  currentRunMessage,
  selectWorkPanelMessage,
} = useChatMessageRuntime({
  activeRun: _activeRun,
  showToast,
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
  showToast,
  invalidateActiveStream: () => invalidateActiveStream(),
  beginInitialScrollRestore,
  endInitialScrollRestore,
});

const {
  loadContextSnapshot,
  checkSessionTaskStatus, clearExecutionState: _clearExecutionStateBase,
} = useSessionTaskStatus({
  shouldRefreshFn: shouldRefreshSessionMessagesAfterResume,
  shouldRunWatchdogFn: shouldRunResumeRecoveryWatchdog,
  invalidateActiveStream: () => invalidateActiveStream(),
  loadSessionMessages,
  deleteMessageCache,
  createAssistantMessage,
  scheduleCommandFallback: (...a) => scheduleCommandFallback(...a),
  scheduleResumeRecovery: (...a) => scheduleSessionResumeRecovery(...a),
  clearLlmRetryState,
  mergeExecutionObservability: (payload) => mergeExecutionObservability(payload),
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
  respondInteraction: (id, response) => respondInteraction(id, response),
  showToast,
});

const visibleWorkPanel = computed(() => showWorkPanel.value);
const hasMessages = computed(() => messages.value.length > 0);
// Layout phase (has-messages/workbench) + transient motion flags on .chat-main,
// consolidated to a single source of truth. is-new-chat dropped (== !has-messages).
const chatMainClasses = computed(() => ({
  'has-messages': hasMessages.value,
  'workbench-layout': visibleWorkPanel.value,
  'is-launching-chat': newChatLaunching.value,
  'is-switching-to-new-chat': switchingToNewChat.value,
  'is-restoring-session-scroll': restoringSessionScroll.value,
}));

const {
  invalidateActiveStream, scheduleCommandFallback,
  scheduleSessionResumeRecovery,
  connectSessionWS, disconnectSessionWS, resetSessionEventCursor,
  resetStreamSessionState,
  send: sendSessionMessage,
  stop: handleStop,
  respondInteraction,
  mergeExecutionObservability,
} = useSessionAgentClient({
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
  clearLlmRetryState,
  setLlmRetryState,
  checkSituationScreenTrigger: (...a) => checkSituationScreenTrigger(...a),
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
  sessionFilesDrawerVisible,
  sessionFilesDrawerTarget,
  normalizeAttachment,
  showToast,
  cacheMessages,
  activeRun: _activeRun,
  isLoading,
  materializeAttachmentsForSend,
  getCurrentSelectedLlm,
  stickToBottom,
});

// ── 态势大屏与消息产物 ──────────────────────────────────────────
const situationScreenActive = ref(false);
const situationArtifactId = ref(null);
const situationMapData = ref(null);
const situationInfo = ref(null);

const {
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
  sessionFiles,
  sessionFilesDrawerVisible,
  sessionFilesDrawerTarget,
  loadSessionMessages,
  loadSessionFiles,
  connectSessionWS,
  disconnectSessionWS,
  invalidateActiveStream,
  resetSessionEventCursor,
  clearExecutionState: (...a) => clearExecutionState(...a),
  checkSessionTaskStatus,
  clearComposerAttachments,
  showToast,
});

const {
  messageKey,
  visibleMessages,
  injectionsByRunId,
  copyMessage,
} = useMessageListView({
  messages,
  showToast,
});

const messageContext = reactive({
  messageKey,
  toggleExecutionView,
  getAssistantRuntimeStatusText,
  handleEnterSituation,
  getAttachmentPreviewUrl,
  openAttachmentImages,
  confirmEditAndResend,
  cancelEdit,
  openSessionFilesDrawer,
  removeEditingAttachment,
  startEditMessage,
  copyMessage,
  getWorkPanelMessageKey,
  selectWorkPanelMessage,
  rollbackAndRetry,
  currentSessionId,
  showWorkPanel: visibleWorkPanel,
  isLoading,
  selectedWorkPanelMessageKey,
  editingMessage,
  editingDraft,
  editingAttachmentsDraft,
  editingSubmitting,
  injectionsByRunId,
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
    if (import.meta.env.DEV && route.query?.__smoke === 'empty') {
      disconnectSessionWS();
      invalidateActiveStream();
      clearExecutionState();
      currentSessionId.value = null;
      messages.value = [];
      contextUsage.value = null;
      isLoading.value = false;
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
      isLoading.value = false;
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

onMounted(() => {
  resetFollowing();
  updateScrollBottomGap();
  if (route.params.id) scrollToBottom(true);
  else resetScrollPosition(false);
  loadEntryAgentOptions();
  loadActiveTeam();
  loadRecentSessions(true);
});

onUnmounted(() => {
  clearNewChatLaunchTimer();
  clearSessionScrollRestoreTimer();
  pendingSessionScrollRestores = 0;
  clearLlmRetryState();
  disconnectSessionWS();

  // 不再通知后端停止任务 — Agent 继续在后台执行

  invalidateActiveStream();

});
</script>

<style src="../styles/chat-view.css"></style>
<style>
.followup-candidate-area {
  display: flex;
  flex-direction: column;
  gap: 5px;
  margin: 0 auto 8px;
  width: min(100%, 920px);
}

.followup-candidate {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 7px 10px;
  border-left: 2px solid var(--color-brand-accent);
  background: var(--surface-shell);
  color: var(--color-text-secondary);
  font-size: 12px;
  line-height: 1.35;
}

.followup-candidate.is-failed {
  border-left-color: var(--color-error);
}

.followup-candidate-state {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-weight: 650;
}

.followup-candidate.is-failed .followup-candidate-state {
  color: var(--color-error);
}

.followup-candidate-content {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.followup-candidate-enter-active,
.followup-candidate-leave-active {
  transition: opacity 160ms ease, transform 160ms ease;
}

.followup-candidate-enter-from,
.followup-candidate-leave-to {
  opacity: 0;
  transform: translateY(5px);
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

.composer-run-controls {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  align-items: center;
  gap: 2px;
}

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

@media (max-width: 640px) {
  .execution-pill {
    margin-left: 0;
  }
}

@media (max-width: 480px) {
  .composer-run-controls {
    max-width: 220px;
  }

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

.scroll-unread-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 600;
  line-height: 1;
  color: var(--color-accent-fg);
  background: var(--color-accent);
  border: 2px solid var(--color-bg-primary);
  border-radius: var(--radius-full);
  font-variant-numeric: tabular-nums;
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
  line-height: 1;
  min-height: 28px;
  border-radius: var(--radius-full);
  background: var(--color-warning-bg, rgba(250, 173, 20, 0.1));
  color: var(--color-warning);
  font-size: 0.8rem;
  font-weight: 600;
  border: 1px solid rgba(250, 173, 20, 0.2);
  width: fit-content;
}

.stopped-badge svg {
  flex-shrink: 0;
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
