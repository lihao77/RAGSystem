<template>
  <div v-if="msg.metadata?.source === 'background_notification'" class="task-notification-block">
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

  <div v-else-if="messageContext.editingMessage !== msg" class="user-bubble-wrapper message-view-mode">
    <div class="user-text">{{ msg.content }}</div>
    <div v-if="msg.attachments?.length" class="user-attachments">
      <div v-if="imageAttachments.length" class="user-attachment-images">
        <button
          v-for="attachment in imageAttachments"
          :key="attachment.file_id || attachment.id || attachment.local_id || attachment.stored_name"
          class="user-attachment-thumb-btn"
          @click="messageContext.openAttachmentImages(msg.attachments, attachment)"
        >
          <img
            :src="messageContext.getAttachmentPreviewUrl(attachment)"
            :alt="attachment.original_name || attachment.stored_name"
            class="user-attachment-thumb"
          />
        </button>
      </div>
      <div
        v-for="attachment in fileAttachments"
        :key="attachment.file_id || attachment.id || attachment.local_id || attachment.stored_name"
        class="user-attachment-card"
      >
        <div class="user-attachment-file-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><polyline points="14 2 14 8 20 8" /></svg>
        </div>
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
      :model-value="messageContext.editingDraft"
      :attachments="messageContext.editingAttachmentsDraft"
      :submitting="messageContext.editingSubmitting"
      :session-id="messageContext.currentSessionId"
      @update:model-value="emit('update:editingDraft', $event)"
      @confirm="messageContext.confirmEditAndResend"
      @cancel="messageContext.cancelEdit"
      @open-attachments="messageContext.openSessionFilesDrawer('message-edit')"
      @remove-attachment="messageContext.removeEditingAttachment"
    />
  </div>
</template>

<script setup>
import MessageEditBox from '../MessageEditBox.vue';
import { formatAttachmentMeta, isImageAttachment } from '../../utils/sessionAttachments.js';
import { parseTaskNotifications } from '../../utils/message-render.js';
import { computed, inject } from 'vue';

const props = defineProps({
  msg: { type: Object, required: true },
});

const emit = defineEmits(['update:editingDraft']);
const messageContext = inject('messageContext');
const imageAttachments = computed(() => (props.msg.attachments || []).filter(isImageAttachment));
const fileAttachments = computed(() => (props.msg.attachments || []).filter((attachment) => !isImageAttachment(attachment)));
</script>
