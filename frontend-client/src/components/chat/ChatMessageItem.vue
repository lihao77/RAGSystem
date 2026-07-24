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
import AssistantMessage from './AssistantMessage.vue';
import MessageActions from './MessageActions.vue';
import UserMessage from './UserMessage.vue';
import { computed, inject } from 'vue';
import { RENDERERS, getMessageExtensions } from '../../utils/messageExtensions.js';

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

</script>
