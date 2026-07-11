<template>
  <div
    :class="[
      'message',
      msg.role,
      { 'message--session-followup': msg.metadata?.execution_kind === 'session_followup' || msg.metadata?.source === 'running_session' },
    ]"
    :data-msg-index="index"
    @mouseenter="emit('hover', index)"
    @mouseleave="emit('hover', null)"
  >
    <div v-if="msg.metadata?.msg_type === 'command_result'" class="message-content-wrapper">
      <CommandResultMessage :message="msg" />
    </div>

    <div
      v-else-if="!showWorkPanel && msg.role === 'assistant' && (hasExecutionContent(msg) || !msg.finished)"
      class="subtasks-container-full"
    >
      <SubtaskStatusTicker
        :execution-tree="msg.executionTree"
        :expanded="msg.showFullSubtasks"
        :running="!msg.finished"
        :has-execution="msg.has_execution"
        :loading="msg.executionStepsLoading"
        @toggle-view="toggleExecutionView(msg)"
      />

      <transition name="expand">
        <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
          <HierarchicalExecutionTree
            :execution-tree="msg.executionTree"
            :injections="currentInjections"
            :session-id="currentSessionId"
          />
        </div>
      </transition>
    </div>

    <div class="message-content-wrapper">
      <template v-for="(ext, i) in aboveExts" :key="`ext-above-${i}`">
        <component :is="RENDERERS[ext.kind].component" :data="ext.data" :msg="msg" />
      </template>
      <div class="message-content">
        <AssistantMessage
          v-if="msg.role === 'assistant'"
          :msg="msg"
          :get-assistant-runtime-status-text="getAssistantRuntimeStatusText"
          :handle-enter-situation="handleEnterSituation"
          @notify="emit('notify', $event)"
        />
        <UserMessage
          v-if="msg.role === 'user'"
          :msg="msg"
          :current-session-id="currentSessionId"
          :editing-message="editingMessage"
          :editing-draft="editingDraft"
          :editing-attachments-draft="editingAttachmentsDraft"
          :editing-submitting="editingSubmitting"
          :get-attachment-preview-url="getAttachmentPreviewUrl"
          :confirm-edit-and-resend="confirmEditAndResend"
          :cancel-edit="cancelEdit"
          :open-session-files-drawer="openSessionFilesDrawer"
          :remove-editing-attachment="removeEditingAttachment"
          @update:editing-draft="emit('update:editingDraft', $event)"
        />
      </div>
      <template v-for="(ext, i) in belowExts" :key="`ext-below-${i}`">
        <component :is="RENDERERS[ext.kind].component" :data="ext.data" :msg="msg" />
      </template>
    </div>

    <MessageActions
      :msg="msg"
      :visible="actionsVisible || editingMessage === msg"
      :show-work-panel="showWorkPanel"
      :is-loading="isLoading"
      :selected-work-panel-message-key="selectedWorkPanelMessageKey"
      :retry-message="retryMessage"
      :editing-message="editingMessage"
      :start-edit-message="startEditMessage"
      :copy-message="copyMessage"
      :get-work-panel-message-key="getWorkPanelMessageKey"
      :select-work-panel-message="selectWorkPanelMessage"
      :rollback-and-retry="rollbackAndRetry"
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
import { computed } from 'vue';
import { RENDERERS, getMessageExtensions } from '../../utils/messageExtensions.js';
import { hasExecutionContent } from '../../utils/message-render.js';

const props = defineProps({
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
  toggleExecutionView: { type: Function, required: true },
  getAssistantRuntimeStatusText: { type: Function, required: true },
  handleEnterSituation: { type: Function, required: true },
  getAttachmentPreviewUrl: { type: Function, required: true },
  confirmEditAndResend: { type: Function, required: true },
  cancelEdit: { type: Function, required: true },
  openSessionFilesDrawer: { type: Function, required: true },
  removeEditingAttachment: { type: Function, required: true },
  startEditMessage: { type: Function, required: true },
  copyMessage: { type: Function, required: true },
  getWorkPanelMessageKey: { type: Function, required: true },
  selectWorkPanelMessage: { type: Function, required: true },
  rollbackAndRetry: { type: Function, required: true },
  injectionsByRunId: { type: Object, default: () => ({}) },
});

const emit = defineEmits(['hover', 'update:editingDraft', 'notify']);

// Message Extension 渲染编排:按 slot 分组(above=content 上方 / below=下方)。
// replace slot 留待第 4 步 command_result 收编(届时加顶层拦截)。本期 only ui_context(above)。
const renderableExts = computed(() => getMessageExtensions(props.msg).filter((e) => RENDERERS[e.kind]));
const aboveExts = computed(() => renderableExts.value.filter((e) => RENDERERS[e.kind].slot === 'above'));
const belowExts = computed(() => renderableExts.value.filter((e) => RENDERERS[e.kind].slot === 'below'));

// 本 run 的注入消息(followup/后台通知):按 run_id 取,挂进 executionTree 作 injection 节点。
const currentInjections = computed(() => {
  const runId = props.msg?.run_id || props.msg?.metadata?.run_id;
  return runId ? (props.injectionsByRunId[runId] || []) : [];
});
</script>
