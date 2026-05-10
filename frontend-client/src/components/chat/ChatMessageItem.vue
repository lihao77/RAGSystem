<template>
  <div
    :class="['message', msg.role]"
    :data-msg-index="index"
    @mouseenter="emit('hover', index)"
    @mouseleave="emit('hover', null)"
  >
    <div v-if="msg.role === 'system' && msg.metadata?.type === 'command_result'" class="message-content-wrapper">
      <CommandResultMessage :message="msg" />
    </div>

    <div
      v-else-if="!showWorkPanel && msg.role === 'assistant' && (hasExecutionContent(msg) || !msg.finished)"
      class="subtasks-container-full"
    >
      <SubtaskStatusTicker
        :subtasks="msg.subtasks"
        :execution-steps="msg.execution_steps"
        :expanded="msg.showFullSubtasks"
        :running="!msg.finished"
        :has-execution="msg.has_execution"
        :loading="msg.executionStepsLoading"
        @toggle-view="toggleExecutionView(msg)"
      />

      <transition name="expand">
        <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
          <HierarchicalExecutionTree
            :execution-steps="msg.execution_steps || []"
            :subtasks="msg.subtasks || []"
            :session-id="currentSessionId"
          />
        </div>
      </transition>
    </div>

    <div class="message-content-wrapper">
      <div class="message-content">
        <AssistantMessage
          v-if="msg.role === 'assistant'"
          :msg="msg"
          :get-assistant-runtime-status-text="getAssistantRuntimeStatusText"
          :parse-message-parts="parseMessageParts"
          :render-markdown="renderMarkdown"
          :handle-enter-situation="handleEnterSituation"
          :get-chart-component="getChartComponent"
          :get-chart-props="getChartProps"
        />
        <UserMessage
          v-if="msg.role === 'user'"
          :msg="msg"
          :current-session-id="currentSessionId"
          :editing-message="editingMessage"
          :editing-draft="editingDraft"
          :editing-attachments-draft="editingAttachmentsDraft"
          :editing-submitting="editingSubmitting"
          :parse-task-notifications="parseTaskNotifications"
          :is-image-attachment="isImageAttachment"
          :get-attachment-preview-url="getAttachmentPreviewUrl"
          :format-attachment-meta="formatAttachmentMeta"
          :confirm-edit-and-resend="confirmEditAndResend"
          :cancel-edit="cancelEdit"
          :open-session-files-drawer="openSessionFilesDrawer"
          :remove-editing-attachment="removeEditingAttachment"
          @update:editing-draft="emit('update:editingDraft', $event)"
        />
      </div>
    </div>

    <MessageActions
      :msg="msg"
      :visible="actionsVisible || editingMessage === msg"
      :show-work-panel="showWorkPanel"
      :is-loading="isLoading"
      :selected-work-panel-message-key="selectedWorkPanelMessageKey"
      :retry-message="retryMessage"
      :editing-message="editingMessage"
      :has-execution-content="hasExecutionContent"
      :start-edit-message="startEditMessage"
      :copy-message="copyMessage"
      :get-work-panel-message-key="getWorkPanelMessageKey"
      :select-work-panel-message="selectWorkPanelMessage"
      :rollback-and-retry="rollbackAndRetry"
      :get-message-execution-time-text="getMessageExecutionTimeText"
      :get-message-execution-time-title="getMessageExecutionTimeTitle"
    />
  </div>
</template>

<script setup>
import CommandResultMessage from '../CommandResultMessage.vue';
import HierarchicalExecutionTree from '../HierarchicalExecutionTree.vue';
import SubtaskStatusTicker from '../SubtaskStatusTicker.vue';
import AssistantMessage from './AssistantMessage.vue';
import MessageActions from './MessageActions.vue';
import UserMessage from './UserMessage.vue';

defineProps({
  msg: { type: Object, required: true },
  index: { type: Number, required: true },
  currentSessionId: { type: String, default: '' },
  showWorkPanel: { type: Boolean, default: false },
  isLoading: { type: Boolean, default: false },
  selectedWorkPanelMessageKey: { type: String, default: '' },
  actionsVisible: { type: Boolean, default: false },
  retryMessage: { type: Object, default: null },
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

const emit = defineEmits(['hover', 'update:editingDraft']);
</script>
