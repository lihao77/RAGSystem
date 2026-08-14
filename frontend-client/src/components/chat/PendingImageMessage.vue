<template>
  <div class="message user pending-image-message" :class="`pending-image-message--${phase}`">
    <div class="message-content-wrapper">
      <div class="message-content">
        <div class="user-bubble-wrapper message-view-mode">
          <div v-if="text" class="user-text">{{ text }}</div>
          <div v-if="thumbs.length" class="user-attachments">
            <div class="user-attachment-images">
              <div
                v-for="(thumb, index) in thumbs"
                :key="thumb.key"
                class="user-attachment-thumb-slot pending-image-thumb-slot"
              >
                <AuthenticatedImage
                  :src="thumb.url"
                  :alt="thumb.name"
                  class="user-attachment-thumb pending-image-thumb"
                />
                <Transition name="pending-image-thumb-fade" mode="out-in">
                  <div v-if="thumbStates[index] === 'pending'" key="pending" class="pending-image-thumb-overlay">
                    <span class="pending-image-spinner" aria-hidden="true"></span>
                  </div>
                  <span
                    v-else-if="thumbStates[index] === 'ok'"
                    key="ok"
                    class="pending-image-thumb-badge pending-image-thumb-badge--ok"
                    title="识别完成"
                  >
                    <Check :size="11" />
                  </span>
                  <span
                    v-else
                    key="failed"
                    class="pending-image-thumb-badge pending-image-thumb-badge--failed"
                    title="识别失败"
                  >
                    <TriangleAlert :size="11" />
                  </span>
                </Transition>
              </div>
            </div>
          </div>
          <div class="pending-image-status" role="status">
            <template v-if="phase === 'done'">
              <span
                class="pending-image-status-icon"
                :class="failedCount > 0 ? 'pending-image-status-icon--warn' : 'pending-image-status-icon--ok'"
              >
                <TriangleAlert v-if="failedCount > 0" :size="12" />
                <Check v-else :size="12" />
              </span>
              {{ doneText }}
            </template>
            <template v-else>
              <span class="pending-image-spinner pending-image-spinner--inline" aria-hidden="true"></span>
              {{ statusText }}
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { Check, TriangleAlert } from 'lucide-vue-next';
import AuthenticatedImage from '../common/AuthenticatedImage.vue';
import { imageDescribeProgress, pluginEventState } from '../../composables/usePluginEvents.js';
import {
  pendingImagePhase,
  pendingImageSendState,
  pendingImageThumbStates,
} from '../../composables/usePendingImageSend.js';

/**
 * 发送带图消息 → 消息落库之间的 pending 态用户气泡（幽灵气泡）。
 * DOM 结构与全局样式类对齐正式用户消息（UserMessage），落库替换时无布局跳动；
 * 数据直接读 usePendingImageSend / usePluginEvents 的模块级单例状态。
 */

const text = computed(() => pendingImageSendState.text);
const thumbs = computed(() => pendingImageSendState.thumbs);
const phase = pendingImagePhase;
const thumbStates = pendingImageThumbStates;

const statusText = computed(() => {
  if (phase.value === 'recognizing') {
    const progress = imageDescribeProgress.value;
    return progress ? `正在识别图片…（已完成 ${progress.done}/${progress.total}）` : '正在识别图片…';
  }
  return '正在发送…';
});

const failedCount = computed(() => pluginEventState.imageDescribe.lastOutcome?.failed || 0);

const doneText = computed(() => (failedCount.value > 0 ? `识别完成，${failedCount.value} 张失败` : '识别完成'));
</script>

<style scoped>
/* pending 态整体半透明，done 恢复（落库后即被正式消息替换） */
.pending-image-message .user-bubble-wrapper {
  opacity: 0.72;
  transition: opacity 0.25s ease;
}
.pending-image-message--done .user-bubble-wrapper {
  opacity: 1;
}

/* pending 态缩略图禁用 hover 交互（不开放大镜） */
.pending-image-thumb-slot .pending-image-thumb {
  pointer-events: none;
}
.pending-image-thumb-slot .pending-image-thumb:hover {
  transform: none;
  box-shadow: none;
}

.pending-image-thumb-overlay {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.38);
}

.pending-image-thumb-badge {
  position: absolute;
  top: 4px;
  right: 4px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  color: #fff;
}
.pending-image-thumb-badge--ok {
  background: rgba(34, 160, 90, 0.92);
}
.pending-image-thumb-badge--failed {
  background: rgba(210, 140, 30, 0.95);
}

.pending-image-thumb-fade-enter-active,
.pending-image-thumb-fade-leave-active {
  transition: opacity 0.22s ease;
}
.pending-image-thumb-fade-enter-from,
.pending-image-thumb-fade-leave-to {
  opacity: 0;
}

.pending-image-status {
  display: inline-flex;
  align-items: center;
  align-self: flex-end;
  gap: 6px;
  padding: 0 4px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs, 12px);
  line-height: 1.4;
}

.pending-image-status-icon {
  display: inline-flex;
  align-items: center;
}
.pending-image-status-icon--ok {
  color: var(--color-success, #22a05a);
}
.pending-image-status-icon--warn {
  color: var(--color-warning, #d28c1e);
}

.pending-image-spinner {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35);
  border-top-color: #fff;
  animation: pending-image-spin 0.8s linear infinite;
}
.pending-image-spinner--inline {
  width: 12px;
  height: 12px;
  border-color: var(--color-border-strong, #666);
  border-top-color: var(--color-brand-accent, #4f8cff);
}

@keyframes pending-image-spin {
  to { transform: rotate(360deg); }
}
</style>
