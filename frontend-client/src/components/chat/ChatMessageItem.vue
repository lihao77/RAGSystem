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
      v-else-if="!messageContext.showWorkPanel && msg.role === 'assistant' && (hasExecutionContent(msg) || !msg.finished)"
      class="subtasks-container-full"
    >
      <SubtaskStatusTicker
        :execution-tree="msg.executionTree"
        :expanded="msg.showFullSubtasks"
        :running="!msg.finished"
        :has-execution="msg.has_execution"
        :loading="msg.executionStepsLoading"
        @toggle-view="messageContext.toggleExecutionView(msg)"
      />

      <transition name="expand">
        <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
          <HierarchicalExecutionTree
            :execution-tree="msg.executionTree"
            :injections="currentInjections"
            :session-id="messageContext.currentSessionId"
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
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
        <UserMessage
          v-if="msg.role === 'user'"
          :msg="msg"
          @update:editing-draft="emit('update:editingDraft', $event)"
        />
      </div>
      <template v-for="(ext, i) in belowExts" :key="`ext-below-${i}`">
        <component :is="RENDERERS[ext.kind].component" :data="ext.data" :msg="msg" />
      </template>
    </div>

    <MessageActions
      :msg="msg"
      :visible="actionsVisible || messageContext.editingMessage === msg"
      :retry-message="retryMessage"
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
import { computed, inject } from 'vue';
import { RENDERERS, getMessageExtensions } from '../../utils/messageExtensions.js';
import { hasExecutionContent } from '../../utils/message-render.js';

const props = defineProps({
  msg: { type: Object, required: true },
  index: { type: Number, required: true },
  actionsVisible: { type: Boolean, default: false },
  retryMessage: { type: Object, default: null },
});

const emit = defineEmits(['hover', 'update:editingDraft', 'notify', 'citation-click']);
const messageContext = inject('messageContext');

// Message Extension 渲染编排:按 slot 分组(above=content 上方 / below=下方)。
// replace slot 留待第 4 步 command_result 收编(届时加顶层拦截)。本期 only ui_context(above)。
const renderableExts = computed(() => getMessageExtensions(props.msg).filter((e) => RENDERERS[e.kind]));
const aboveExts = computed(() => renderableExts.value.filter((e) => RENDERERS[e.kind].slot === 'above'));
const belowExts = computed(() => renderableExts.value.filter((e) => RENDERERS[e.kind].slot === 'below'));

// 本 run 的注入消息(followup/后台通知):按 run_id 取,挂进 executionTree 作 injection 节点。
const currentInjections = computed(() => {
  const runId = props.msg?.run_id || props.msg?.metadata?.run_id;
  return runId ? (messageContext.injectionsByRunId[runId] || []) : [];
});
</script>
