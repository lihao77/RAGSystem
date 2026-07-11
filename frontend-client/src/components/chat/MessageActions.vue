<template>
  <div class="message-actions" :class="{ visible }">
    <template v-if="msg.role === 'user' && messageContext.editingMessage !== msg">
      <Button variant="ghost" size="icon-xs" :disabled="messageContext.isLoading" aria-label="编辑" title="编辑" @click="messageContext.startEditMessage(msg)">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="复制" title="复制" @click="messageContext.copyMessage(msg)">
        <IconCopy :size="14" />
      </Button>
    </template>

    <template v-if="msg.role === 'assistant' && msg.finished">
      <Button
        v-if="messageContext.showWorkPanel && hasExecutionContent(msg)"
        variant="ghost"
        size="icon-xs"
        :active="messageContext.selectedWorkPanelMessageKey === messageContext.getWorkPanelMessageKey(msg)"
        aria-label="在工作栏查看执行树"
        title="在工作栏查看执行树"
        @click="messageContext.selectWorkPanelMessage(msg)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M6 3v12" />
          <circle cx="6" cy="18" r="3" />
          <path d="M6 9h8" />
          <circle cx="17" cy="9" r="3" />
        </svg>
      </Button>
      <Button variant="ghost" size="icon-xs" aria-label="复制" title="复制" @click="messageContext.copyMessage(msg)">
        <IconCopy :size="14" />
      </Button>
      <Button
        v-if="retryMessage"
        variant="ghost"
        size="icon-xs"
        :disabled="messageContext.isLoading"
        aria-label="重试"
        title="重试"
        @click="messageContext.rollbackAndRetry(retryMessage)"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
          <path d="M16 16h5v5" />
        </svg>
      </Button>
      <span
        v-if="getMessageExecutionTimeText(msg)"
        class="message-execution-time"
        :title="getMessageExecutionTimeTitle(msg)"
      >
        {{ getMessageExecutionTimeText(msg) }}
      </span>
    </template>
  </div>
</template>

<script setup>
import IconCopy from '../icons/IconCopy.vue';
import { Button } from '../ui/button';
import {
  getMessageExecutionTimeText,
  getMessageExecutionTimeTitle,
  hasExecutionContent,
} from '../../utils/message-render.js';
import { inject } from 'vue';
defineProps({
  msg: { type: Object, required: true },
  visible: { type: Boolean, default: false },
  retryMessage: { type: Object, default: null },
});
const messageContext = inject('messageContext');
</script>
