<template>
  <div class="chat-messages">
    <div v-if="latched && scrollContainer" class="message-window-controls sticky top-0 flex justify-end">
      <Button variant="secondary" size="sm" @click="toggleAll()">
        {{ showAll ? '恢复按需显示' : '显示全部消息以便查找' }}
      </Button>
    </div>
    <Transition name="chat-stage" mode="out-in">
      <div v-if="messagesLoading" key="loading" class="messages-skeleton">
        <div v-for="n in 6" :key="`msg-skeleton-${n}`" class="message-skeleton-row"></div>
      </div>

      <div v-else-if="messages.length === 0 && !tailActive" key="welcome" class="welcome-screen">
        <slot name="empty">
          <div class="welcome-content">
            <div class="welcome-header">
              <div class="logo-placeholder">
                <IconLogo :size="80" animated />
              </div>
              <h1>RAG Agent System</h1>
              <p class="welcome-subtitle">Dynamic Agent Orchestration with ReAct Pattern</p>
            </div>
          </div>
        </slot>
      </div>

      <div v-else key="stream" ref="stream" class="message-stream" :class="{ 'message-stream--windowed': active, 'message-stream--history': latched && scrollContainer }"
        role="list" aria-label="聊天消息" @click="scheduleMeasure" @focusin="scheduleMeasure" @focusout="scheduleMeasure">
        <template v-for="entry in entries" :key="entry.key">
          <div v-if="entry.height !== undefined" class="message-window-spacer" :style="{ height: `${entry.height}px` }" aria-hidden="true" />
          <ChatMessageItem
            v-else
            :ref="bindRow(entry.key)"
            :msg="visibleMessages[entry.index]"
            :index="entry.index"
            role="listitem"
            :aria-posinset="entry.index + 1"
            :aria-setsize="visibleMessages.length"
            :style="active ? { paddingTop: leadingGap(entry.index) } : undefined"
            :actions-visible="messageActionsVisible === entry.index"
            :retry-message="retryMessages[entry.index]"
            @hover="messageActionsVisible = $event"
            @update:editing-draft="emit('update:editingDraft', $event)"
            @notify="emit('notify', $event)"
            @citation-click="emit('citation-click', $event)"
          />
        </template>
        <!-- 消息流尾部挂点：待落库的 pending 用户消息（带图发送的识别中幽灵气泡）等 -->
        <slot name="tail" />
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { computed, inject, ref, toRef } from 'vue';
import { IconLogo } from '../icons';
import { Button } from '../ui/button';
import { buildRetryMessages } from '../../composables/useMessageListView.js';
import { useMessageWindow } from '../../composables/useMessageWindow.js';
import ChatMessageItem from './ChatMessageItem.vue';

const props = defineProps({
  messagesLoading: { type: Boolean, default: false },
  messages: { type: Array, default: () => [] },
  visibleMessages: { type: Array, default: () => [] },
  // 消息流尾部是否有待落库内容（如带图发送的幽灵气泡）：有则空会话也渲染 stream 分支。
  tailActive: { type: Boolean, default: false },
  scrollContainer: { type: Object, default: null },
  following: { type: Boolean, default: false },
  contextKey: { type: String, default: '' },
});

const emit = defineEmits(['update:editingDraft', 'notify', 'citation-click']);
const messageContext = inject('messageContext');
const messageActionsVisible = ref(null);
const stream = ref(null);
const rows = computed(() => props.visibleMessages.map(msg => ({ msg, key: messageContext.messageKey(msg) })));
const { active, latched, showAll, entries, bindRow, scheduleMeasure, scrollToMessage, toggleAll } = useMessageWindow({
  rows, stream, container: toRef(props, 'scrollContainer'), following: toRef(props, 'following'),
  contextKey: toRef(props, 'contextKey'), editingMessage: toRef(messageContext, 'editingMessage'),
});
const leadingGap = (index) => {
  if (!index) return '0px';
  const previous = props.visibleMessages[index - 1];
  return previous.role === 'user' && (previous.has_execution || previous.executionTree?.root)
    && props.visibleMessages[index].role === 'assistant' ? '6px' : 'var(--message-list-gap)';
};
defineExpose({ scrollToMessage });

const retryMessages = computed(() => buildRetryMessages(props.visibleMessages, messageContext.canReviseMessage));
</script>
