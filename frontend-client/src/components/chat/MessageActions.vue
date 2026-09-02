<template>
  <div class="message-actions" :class="{ visible }">
    <template v-if="msg.role === 'user' && messageContext.editingMessage !== msg">
      <Button v-if="messageContext.canReviseMessage(msg)" variant="ghost" size="icon-xs" :disabled="messageContext.isLoading" aria-label="编辑" title="编辑" @click="messageContext.startEditMessage(msg)">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
          <path d="m15 5 4 4" />
        </svg>
      </Button>
      <Button variant="ghost" size="icon-xs" :aria-label="copied ? '已复制' : '复制'" :title="copied ? '已复制' : '复制'" @click="onCopy(msg)">
        <IconCheck v-if="copied" :size="14" />
        <IconCopy v-else :size="14" />
      </Button>
    </template>

    <template v-if="msg.role === 'assistant'">
      <template v-if="msg.finished">
        <Button variant="ghost" size="icon-xs" :aria-label="copied ? '已复制' : '复制'" :title="copied ? '已复制' : '复制'" @click="onCopy(msg)">
          <IconCheck v-if="copied" :size="14" />
          <IconCopy v-else :size="14" />
        </Button>
        <Button
          v-if="messageContext.rateMessage"
          variant="ghost"
          size="icon-xs"
          :aria-pressed="feedbackOf(msg) === 'up'"
          :aria-label="feedbackOf(msg) === 'up' ? '取消点赞' : '点赞'"
          :title="feedbackOf(msg) === 'up' ? '取消点赞' : '点赞'"
          @click="onRate(msg, 'up')"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" :fill="feedbackOf(msg) === 'up' ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M7 10v12" />
            <path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z" />
          </svg>
        </Button>
        <Button
          v-if="messageContext.rateMessage"
          variant="ghost"
          size="icon-xs"
          :aria-pressed="feedbackOf(msg) === 'down'"
          :aria-label="feedbackOf(msg) === 'down' ? '取消点踩' : '点踩'"
          :title="feedbackOf(msg) === 'down' ? '取消点踩' : '点踩'"
          @click="onRate(msg, 'down')"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" :fill="feedbackOf(msg) === 'down' ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M17 14V2" />
            <path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z" />
          </svg>
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
    </template>
  </div>
</template>

<script setup>
import IconCopy from '../icons/IconCopy.vue';
import IconCheck from '../icons/IconCheck.vue';
import { Button } from '../ui/button';
import {
  getMessageExecutionTimeText,
  getMessageExecutionTimeTitle,
} from '../../utils/message-render.js';
import { inject, ref, onUnmounted } from 'vue';
defineProps({
  msg: { type: Object, required: true },
  visible: { type: Boolean, default: false },
  retryMessage: { type: Object, default: null },
});
const messageContext = inject('messageContext');

// 复制反馈：点击后图标短暂变 ✓，给操作即时可感知的反馈（toast 在顶部，按钮 inline 更直接）
const copied = ref(false);
let copyTimer = null;
const onCopy = async (msg) => {
  try { await messageContext.copyMessage(msg); } catch (e) { /* 复制失败由 toast 提示 */ }
  copied.value = true;
  if (copyTimer) clearTimeout(copyTimer);
  copyTimer = setTimeout(() => { copied.value = false; }, 1500);
};
onUnmounted(() => { if (copyTimer) clearTimeout(copyTimer); });

// 赞/踩：当前评价态由 ChatViewV2 的反馈映射提供；同值再点 = 取消（切换在 rateMessage 内处理）
const feedbackOf = (msg) => messageContext.getMessageFeedback?.(msg.id) ?? null;
const onRate = async (msg, value) => {
  try { await messageContext.rateMessage?.(msg, value); } catch (e) { /* 失败已在 rateMessage 内 toast */ }
};
</script>
