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
        <div
          v-if="msg.role === 'assistant' && !msg.content && (!msg.subtasks || msg.subtasks.length === 0) && !msg.finished"
          class="loading-indicator"
        >
          <div class="loading-dots" aria-hidden="true">
            <div class="dot"></div>
            <div class="dot"></div>
            <div class="dot"></div>
          </div>
          <span class="loading-text">{{ getAssistantRuntimeStatusText(msg) || '正在运行...' }}</span>
        </div>

        <template v-if="msg.role === 'assistant'">
          <template v-for="(part, pi) in parseMessageParts(msg)" :key="pi">
            <div v-if="part.type === 'text' && part.content?.trim()" class="final-answer">
              <div class="markdown-body" v-html="renderMarkdown(part.content)"></div>
            </div>
            <div v-else-if="part.type === 'viz'" class="inline-chart-wrapper">
              <VisualizationLoader :artifactId="part.artifactId" @enter-situation="handleEnterSituation" />
            </div>
            <div v-else-if="part.type === 'chart'" class="inline-chart-wrapper">
              <component
                :is="getChartComponent(msg.multimodalContents[part.index])"
                v-bind="getChartProps(msg.multimodalContents[part.index])"
              />
            </div>
          </template>
          <div v-if="msg.stopped" class="stopped-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="6" y="6" width="12" height="12" rx="2"></rect>
            </svg>
            <span>{{ msg.metadata?.interrupted ? '已中断' : '已停止生成' }}</span>
          </div>
        </template>

        <template v-if="msg.role === 'user'">
          <div v-if="msg.metadata?.source === 'system.bg_notification'" class="task-notification-block">
            <div class="task-notification-header">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
              <span>Background Task Notification</span>
            </div>
            <div class="task-notification-body">
              <div v-for="item in parseTaskNotifications(msg)" :key="item.taskId" class="task-notification-item">
                <span class="tn-status" :class="item.status">{{ item.status }}</span>
                <code class="tn-task-id">{{ item.taskId.slice(0, 8) }}</code>
                <span v-if="item.resultType" class="tn-type">{{ item.resultType }}</span>
              </div>
            </div>
          </div>

          <div v-else-if="editingMessage !== msg" class="user-bubble-wrapper message-view-mode">
            <div class="user-text">{{ msg.content }}</div>
            <div v-if="msg.attachments?.length" class="user-attachments">
              <div
                v-for="attachment in msg.attachments"
                :key="attachment.file_id || attachment.id"
                class="user-attachment-card"
              >
                <img
                  v-if="isImageAttachment(attachment)"
                  :src="getAttachmentPreviewUrl(attachment)"
                  :alt="attachment.original_name || attachment.stored_name"
                  class="user-attachment-image"
                />
                <div v-else class="user-attachment-file-icon">文件</div>
                <div class="user-attachment-info">
                  <div class="user-attachment-name">{{ attachment.original_name || attachment.stored_name }}</div>
                  <div class="user-attachment-meta">{{ formatAttachmentMeta(attachment) }}</div>
                </div>
              </div>
            </div>

            <div v-if="msg.status && msg.status.length > 0" class="status-updates">
              <div v-for="(status, sIndex) in msg.status" :key="sIndex" class="status-tag" :class="status.type">
                <span v-if="status.type === 'error'" class="status-icon">⚠️</span>
                {{ status.content }}
              </div>
            </div>
          </div>

          <div v-else class="message-edit-mode">
            <MessageEditBox
              :model-value="editingDraft"
              :attachments="editingAttachmentsDraft"
              :submitting="editingSubmitting"
              :session-id="currentSessionId"
              @update:model-value="emit('update:editingDraft', $event)"
              @confirm="confirmEditAndResend"
              @cancel="cancelEdit"
              @open-attachments="openSessionFilesDrawer('message-edit')"
              @remove-attachment="removeEditingAttachment"
            />
          </div>
        </template>
      </div>
    </div>

    <div class="message-actions" :class="{ visible: actionsVisible || editingMessage === msg }">
      <template v-if="msg.role === 'user' && editingMessage !== msg">
        <button type="button" class="msg-action-btn btn-edit" :disabled="isLoading" title="编辑" @click="startEditMessage(msg)">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
            <path d="m15 5 4 4" />
          </svg>
        </button>
        <button type="button" class="msg-action-btn btn-copy" title="复制" @click="copyMessage(msg)">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
        </button>
      </template>

      <template v-if="msg.role === 'assistant' && msg.finished">
        <button
          v-if="showWorkPanel && hasExecutionContent(msg)"
          type="button"
          class="msg-action-btn btn-execution-tree"
          :class="{ active: selectedWorkPanelMessageKey === getWorkPanelMessageKey(msg) }"
          title="在工作栏查看执行树"
          @click="selectWorkPanelMessage(msg)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3v12" />
            <circle cx="6" cy="18" r="3" />
            <path d="M6 9h8" />
            <circle cx="17" cy="9" r="3" />
          </svg>
        </button>
        <button type="button" class="msg-action-btn btn-copy" title="复制" @click="copyMessage(msg)">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
            <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
          </svg>
        </button>
        <button
          v-if="retryMessage"
          type="button"
          class="msg-action-btn btn-retry"
          :disabled="isLoading"
          title="重试"
          @click="rollbackAndRetry(retryMessage)"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
            <path d="M3 3v5h5" />
            <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
            <path d="M16 16h5v5" />
          </svg>
        </button>
        <span
          v-if="getMessageExecutionTimeText(msg)"
          class="message-execution-time"
          :title="getMessageExecutionTimeTitle(msg)"
        >
          {{ getMessageExecutionTimeText(msg) }}
        </span>
      </template>
    </div>
  </div>
</template>

<script setup>
import CommandResultMessage from '../CommandResultMessage.vue';
import HierarchicalExecutionTree from '../HierarchicalExecutionTree.vue';
import MessageEditBox from '../MessageEditBox.vue';
import SubtaskStatusTicker from '../SubtaskStatusTicker.vue';
import VisualizationLoader from '../VisualizationLoader.vue';

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
