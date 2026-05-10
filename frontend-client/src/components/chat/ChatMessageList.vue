<template>
  <div class="chat-messages">
    <div v-if="messagesLoading" class="messages-skeleton">
      <div v-for="n in 6" :key="`msg-skeleton-${n}`" class="message-skeleton-row"></div>
    </div>

    <div v-else-if="messages.length === 0" class="welcome-screen">
      <div class="welcome-content">
        <div class="welcome-header">
          <div class="logo-placeholder">
            <IconLogo :size="80" animated />
          </div>
          <h1>RAG Agent System</h1>
          <p class="welcome-subtitle">Dynamic Agent Orchestration with ReAct Pattern</p>
        </div>
      </div>
    </div>

    <div v-else class="message-stream">
      <ChatMessageItem
        v-for="(msg, index) in visibleMessages"
        :key="messageKey(msg)"
        :msg="msg"
        :index="index"
        :current-session-id="currentSessionId"
        :show-work-panel="showWorkPanel"
        :is-loading="isLoading"
        :selected-work-panel-message-key="selectedWorkPanelMessageKey"
        :actions-visible="messageActionsVisible === index"
        :retry-message="getRetryMessage(index)"
        :editing-message="editingMessage"
        :editing-draft="editingDraft"
        :editing-attachments-draft="editingAttachmentsDraft"
        :editing-submitting="editingSubmitting"
        :message-key="messageKey"
        :has-execution-content="hasExecutionContent"
        :toggle-execution-view="toggleExecutionView"
        :get-assistant-runtime-status-text="getAssistantRuntimeStatusText"
        :parse-message-parts="parseMessageParts"
        :render-markdown="renderMarkdown"
        :handle-enter-situation="handleEnterSituation"
        :get-chart-component="getChartComponent"
        :get-chart-props="getChartProps"
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
        @hover="messageActionsVisible = $event"
        @update:editing-draft="emit('update:editingDraft', $event)"
      />
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { IconLogo } from '../icons';
import ChatMessageItem from './ChatMessageItem.vue';

const props = defineProps({
  messagesLoading: { type: Boolean, default: false },
  messages: { type: Array, default: () => [] },
  visibleMessages: { type: Array, default: () => [] },
  currentSessionId: { type: String, default: '' },
  showWorkPanel: { type: Boolean, default: false },
  isLoading: { type: Boolean, default: false },
  selectedWorkPanelMessageKey: { type: String, default: '' },
  editingMessage: { type: Object, default: null },
  editingDraft: { type: String, default: '' },
  editingAttachmentsDraft: { type: Array, default: () => [] },
  editingSubmitting: { type: Boolean, default: false },
  messageKey: { type: Function, required: true },
  hasExecutionContent: { type: Function, required: true },
  toggleExecutionView: { type: Function, required: true },
  getAssistantRuntimeStatusText: { type: Function, required: true },
  parseMessageParts: { type: Function, required: true },
  renderMarkdown: { type: Function, required: true },
  handleEnterSituation: { type: Function, required: true },
  getChartComponent: { type: Function, required: true },
  getChartProps: { type: Function, required: true },
  parseTaskNotifications: { type: Function, required: true },
  isImageAttachment: { type: Function, required: true },
  getAttachmentPreviewUrl: { type: Function, required: true },
  formatAttachmentMeta: { type: Function, required: true },
  confirmEditAndResend: { type: Function, required: true },
  cancelEdit: { type: Function, required: true },
  openSessionFilesDrawer: { type: Function, required: true },
  removeEditingAttachment: { type: Function, required: true },
  startEditMessage: { type: Function, required: true },
  copyMessage: { type: Function, required: true },
  getWorkPanelMessageKey: { type: Function, required: true },
  selectWorkPanelMessage: { type: Function, required: true },
  rollbackAndRetry: { type: Function, required: true },
  getMessageExecutionTimeText: { type: Function, required: true },
  getMessageExecutionTimeTitle: { type: Function, required: true },
});

const emit = defineEmits(['update:editingDraft']);
const messageActionsVisible = ref(null);

function getRetryMessage(index) {
  return props.visibleMessages
    .slice(0, index)
    .findLast(msg => msg.role === 'user' && msg.seq != null) || null;
}
</script>
