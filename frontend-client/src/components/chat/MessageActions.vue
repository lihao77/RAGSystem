<template>
  <div class="message-actions" :class="{ visible }">
    <template v-if="msg.role === 'user' && messageContext.editingMessage !== msg">
      <Button v-if="messageContext.canReviseMessage(msg)" variant="ghost" size="icon-xs" :disabled="messageContext.isLoading" aria-label="编辑" title="编辑" @click="messageContext.startEditMessage(msg)">
        <Pen />
      </Button>
      <Button variant="ghost" size="icon-xs" :aria-label="copied ? '已复制' : '复制'" :title="copied ? '已复制' : '复制'" @click="onCopy(msg)">
        <IconCheck v-if="copied" />
        <IconCopy v-else />
      </Button>
    </template>

    <template v-if="msg.role === 'assistant'">
      <template v-if="msg.finished">
        <Button variant="ghost" size="icon-xs" :aria-label="copied ? '已复制' : '复制'" :title="copied ? '已复制' : '复制'" @click="onCopy(msg)">
          <IconCheck v-if="copied" />
          <IconCopy v-else />
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
          <ThumbsUp :fill="feedbackOf(msg) === 'up' ? 'currentColor' : 'none'" />
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
          <ThumbsDown :fill="feedbackOf(msg) === 'down' ? 'currentColor' : 'none'" />
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
          <RefreshCcw />
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
import { Pen, RefreshCcw, ThumbsDown, ThumbsUp } from 'lucide-vue-next';
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
