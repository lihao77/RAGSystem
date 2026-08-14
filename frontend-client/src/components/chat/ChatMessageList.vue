<template>
  <div class="chat-messages">
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

      <div v-else key="stream" class="message-stream">
        <ChatMessageItem
          v-for="(msg, index) in visibleMessages"
          :key="messageContext.messageKey(msg)"
          :msg="msg"
          :index="index"
          :actions-visible="messageActionsVisible === index"
          :retry-message="getRetryMessage(index)"
          @hover="messageActionsVisible = $event"
          @update:editing-draft="emit('update:editingDraft', $event)"
          @notify="emit('notify', $event)"
          @citation-click="emit('citation-click', $event)"
        />
        <!-- 消息流尾部挂点：待落库的 pending 用户消息（带图发送的识别中幽灵气泡）等 -->
        <slot name="tail" />
      </div>
    </Transition>
  </div>
</template>

<script setup>
import { inject, ref } from 'vue';
import { IconLogo } from '../icons';
import { findRetryMessage } from '../../composables/useMessageListView.js';
import ChatMessageItem from './ChatMessageItem.vue';

const props = defineProps({
  messagesLoading: { type: Boolean, default: false },
  messages: { type: Array, default: () => [] },
  visibleMessages: { type: Array, default: () => [] },
  // 消息流尾部是否有待落库内容（如带图发送的幽灵气泡）：有则空会话也渲染 stream 分支。
  tailActive: { type: Boolean, default: false },
});

const emit = defineEmits(['update:editingDraft', 'notify', 'citation-click']);
const messageContext = inject('messageContext');
const messageActionsVisible = ref(null);

function getRetryMessage(index) {
  return findRetryMessage(
    props.visibleMessages,
    index,
    messageContext.canReviseMessage,
  );
}
</script>
