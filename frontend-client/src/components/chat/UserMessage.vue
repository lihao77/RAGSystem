<template>
  <div v-if="msg.metadata?.source === 'background_notification'" class="task-notification-block">
    <div class="task-notification-header">
      <Monitor :size="14" />
      <span>Background Task Notification</span>
    </div>
    <div
      ref="notificationBodyEl"
      class="task-notification-body"
      :class="{ 'is-clampable': notificationClampable, 'is-clamped': notificationClampable && !notificationExpanded }"
    >
      <div v-for="item in taskNotifications" :key="item.taskId" class="task-notification-item">
        <span class="tn-status" :class="item.status">{{ item.status }}</span>
        <code class="tn-task-id">{{ item.taskId.slice(0, 8) }}</code>
        <span v-if="item.resultType" class="tn-type">{{ item.resultType }}</span>
      </div>
      <button
        v-if="notificationClampable"
        type="button"
        class="bubble-clamp-toggle"
        :class="{ 'is-expanded': notificationExpanded }"
        :aria-label="notificationExpanded ? '收起通知列表' : '展开全部通知'"
        :title="notificationExpanded ? '收起通知列表' : '展开全部通知'"
        @click="toggleNotificationClamp"
      >
        <ChevronDown :size="14" />
      </button>
    </div>
  </div>

  <div v-else-if="msg.metadata?.source === 'goal_continuation'" class="task-notification-block">
    <div class="task-notification-header">
      <span>Goal 自动续跑</span>
    </div>
    <div class="task-notification-body">
      <div class="task-notification-item">
        <span class="tn-status running">进行中</span>
        <code v-if="msg.metadata?.goal_id" class="tn-task-id">
          {{ String(msg.metadata.goal_id).slice(0, 8) }}
        </code>
        <span class="tn-type">继续检查并推进未完成目标</span>
      </div>
    </div>
  </div>

  <div v-else-if="messageContext.editingMessage !== msg" class="user-bubble-wrapper message-view-mode">
    <div v-if="isAgentMessage" class="agent-message-label">{{ agentMessageLabel }}</div>
    <div
      v-if="displayText"
      ref="userTextEl"
      class="user-text"
      :class="{ 'is-clampable': textClampable, 'is-clamped': textClampable && !textExpanded }"
    >{{ displayText }}<button
      v-if="textClampable"
      type="button"
      class="bubble-clamp-toggle"
      :class="{ 'is-expanded': textExpanded }"
      :aria-label="textExpanded ? '收起' : '展开'"
      :title="textExpanded ? '收起' : '展开'"
      @click="toggleTextClamp"
    >
      <ChevronDown :size="14" />
    </button></div>
    <div v-if="msg.attachments?.length" class="user-attachments">
      <div v-if="imageAttachments.length" class="user-attachment-images">
        <div
          v-for="attachment in imageAttachments"
          :key="attachment.file_id || attachment.id || attachment.local_id || attachment.stored_name"
          class="user-attachment-thumb-slot"
        >
          <button
            class="user-attachment-thumb-btn"
            @click="messageContext.openAttachmentImages(msg.attachments, attachment)"
          >
            <AuthenticatedImage
              :src="messageContext.getAttachmentPreviewUrl(attachment)"
              :alt="attachment.original_name || attachment.stored_name"
              class="user-attachment-thumb"
            />
          </button>
          <Popover v-if="imageDescriptionFor(attachment)">
            <PopoverTrigger as-child>
              <button
                type="button"
                class="image-desc-badge"
                :aria-label="`查看${attachment.original_name || '图片'}的 AI 描述`"
                title="查看图片描述"
              >
                <ScanText :size="12" />
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" class="max-h-[340px] max-w-[360px] overflow-y-auto whitespace-pre-wrap break-words text-xs leading-relaxed">
              {{ imageDescriptionFor(attachment) }}
            </PopoverContent>
          </Popover>
        </div>
      </div>
      <div
        v-for="attachment in fileAttachments"
        :key="attachment.file_id || attachment.id || attachment.local_id || attachment.stored_name"
        class="user-attachment-card"
      >
        <div class="user-attachment-file-icon">
          <File />
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
import AuthenticatedImage from '../common/AuthenticatedImage.vue';
import { formatAttachmentMeta, isImageAttachment } from '../../utils/sessionAttachments.js';
import { parseTaskNotifications } from '../../utils/message-render.js';
import { getImageDescriptionMap, getUserDisplayText } from '../../utils/messageContentParts.js';
import { useClampedExpand } from '../../composables/useClampedExpand.js';
import { computed, inject, ref } from 'vue';
import { ChevronDown, File, Monitor, ScanText } from 'lucide-vue-next';
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover/index';

const props = defineProps({
  msg: { type: Object, required: true },
});

const emit = defineEmits(['update:editingDraft']);
const messageContext = inject('messageContext');
const imageAttachments = computed(() => (props.msg.attachments || []).filter(isImageAttachment));
const fileAttachments = computed(() => (props.msg.attachments || []).filter((attachment) => !isImageAttachment(attachment)));
// 超高气泡折叠（含智能体消息正文）：正文/通知列表钉住钳高渐隐，气泡内底部悬浮
// 图标胶囊按钮展开/收起。附件缩略图与状态标签不进钳高。
const userTextEl = ref(null);
const { expanded: textExpanded, clampable: textClampable, toggle: toggleTextClamp } = useClampedExpand(userTextEl, { clamp: 120 });
const notificationBodyEl = ref(null);
const { expanded: notificationExpanded, clampable: notificationClampable, toggle: toggleNotificationClamp } = useClampedExpand(notificationBodyEl, { clamp: 132 });
const taskNotifications = computed(() => (
  props.msg.metadata?.source === 'background_notification' ? parseTaskNotifications(props.msg) : []
));
const isAgentMessage = computed(() => props.msg.metadata?.agent_message === true);
const agentMessageLabel = computed(() => {
  const metadata = props.msg.metadata || {};
  const source = metadata.agent_message_source_agent_name || metadata.source_agent_name || '智能体';
  const kind = metadata.mailbox_kind;
  const kindLabels = { progress: '进度', request: '请求', response: '回复', result: '结果' };
  return `${source} · ${kindLabels[kind] || '消息'}`;
});
/** 正文展示文本：排除图片描述 part（描述以缩略图角标收纳）。 */
const displayText = computed(() => getUserDisplayText(props.msg));
/** 图片 file_id → 描述文本（来自 content_parts 中紧跟 attachment_ref 的描述 part）。 */
const imageDescriptions = computed(() => getImageDescriptionMap(props.msg));
function attachmentKey(attachment) {
  return attachment.file_id || attachment.id || '';
}
function imageDescriptionFor(attachment) {
  const fileId = attachmentKey(attachment);
  return fileId ? (imageDescriptions.value[fileId] || '') : '';
}
</script>

<style scoped>
.user-attachment-thumb-slot {
  position: relative;
}

.user-attachment-thumb-btn {
  position: relative;
}

.image-desc-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  cursor: pointer;
}

.image-desc-badge:hover {
  background: rgba(0, 0, 0, 0.8);
}

</style>
