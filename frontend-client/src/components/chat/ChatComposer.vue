<template>
  <div class="bottom-dock" :class="{ 'bottom-dock--launching': newChatLaunching && hasMessages }">
    <Transition name="image-recognition-fade">
      <div v-if="imageRecognitionPending" class="image-recognition-hint" role="status">
        <span class="image-recognition-spinner" aria-hidden="true"></span>
        正在识别图片…<template v-if="imageRecognitionProgress">（{{ imageRecognitionProgress.done }}/{{ imageRecognitionProgress.total }}）</template>
      </div>
    </Transition>
    <div
      class="input-area-wrapper"
      :class="{ 'input-area-wrapper--new-chat': !hasMessages }"
    >
      <ChatInput
        ref="chatInputRef"
        :model-value="modelValue"
        :attachments="attachments"
        :session-id="sessionId"
        :can-send="canSend"
        :can-stop="canStop"
        :can-resume="canResume"
        :can-attach="canAttach"
        @update:model-value="emit('update:modelValue', $event)"
        @send="emit('send', $event)"
        @stop="emit('stop')"
        @resume="emit('resume')"
        @openAttachments="emit('openAttachments')"
        @removeAttachment="emit('removeAttachment', $event)"
        @pasteFiles="emit('pasteFiles', $event)"
      >
        <template v-if="!hasMessages" #context>
          <TaskLauncher
            :team="team"
            :team-options="teamOptions"
            :team-loading="teamLoading"
            :entry-agent="entryAgent"
            :workspace-root="workspaceRoot"
            :entry-agent-options="entryAgentOptions"
            :entry-agent-loading="entryAgentLoading"
            @update:team="emit('update:team', $event)"
            @update:entry-agent="emit('update:entryAgent', $event)"
            @update:workspace-root="emit('update:workspaceRoot', $event)"
          />
        </template>
        <template #footerMeta>
          <div class="composer-run-controls" role="group" aria-label="本次发送设置">
            <LLMSelector presentation="composer" />
            <PermissionModeSelector :session-id="sessionId" :chat-sdk-client="chatSdkClient" />
          </div>
        </template>
        <template #rightActions>
          <div v-if="contextUsage && contextUsage.max > 0" class="context-usage-content" @click="emit('openContextDrawer')" title="点击查看上下文详情">
            <svg width="22" height="22" viewBox="0 0 22 22" class="ctx-ring-master" :title="`上下文: ${contextUsage.used.toLocaleString()} / ${contextUsage.max.toLocaleString()} tokens`">
              <circle cx="11" cy="11" r="9" fill="none" :stroke="'var(--ctx-ring-track)'" stroke-width="2.5" />
              <circle
                cx="11"
                cy="11"
                r="9"
                fill="none"
                :stroke="contextUsageClass === 'danger' ? 'var(--ctx-ring-danger)' : contextUsageClass === 'warning' ? 'var(--ctx-ring-warning)' : 'var(--ctx-ring-success)'"
                stroke-width="2.5"
                stroke-linecap="round"
                :stroke-dasharray="`${contextUsagePct * 0.5655} 56.55`"
                stroke-dashoffset="0"
                :style="{ transform: 'rotate(90deg) scaleX(-1)', transformOrigin: '50% 50%' }"
              />
            </svg>
            <span class="context-usage-label">{{ contextUsage.used.toLocaleString() }} / {{ contextUsage.max.toLocaleString() }} tokens</span>
            <span v-if="isCompressing" class="compressing-indicator">
              <span class="compressing-dot"></span>
              压缩中
            </span>
          </div>
        </template>
      </ChatInput>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import ChatInput from '../ChatInput.vue';
import LLMSelector from '../LLMSelector.vue';
import PermissionModeSelector from '../PermissionModeSelector.vue';
import TaskLauncher from './TaskLauncher.vue';

defineProps({
  modelValue: { type: String, default: '' },
  attachments: { type: Array, default: () => [] },
  canSend: { type: Boolean, default: false },
  canStop: { type: Boolean, default: false },
  canResume: { type: Boolean, default: false },
  canAttach: { type: Boolean, default: false },
  hasMessages: { type: Boolean, default: false },
  newChatLaunching: { type: Boolean, default: false },
  imageRecognitionPending: { type: Boolean, default: false },
  // 多图识别进度（{ done, total }，仅进行中且总数 >1 时传入）。
  imageRecognitionProgress: { type: Object, default: null },
  sessionId: { type: String, default: '' },
  chatSdkClient: { type: Object, default: null },
  contextUsage: { type: Object, default: null },
  contextUsagePct: { type: Number, default: 0 },
  contextUsageClass: { type: String, default: '' },
  isCompressing: { type: Boolean, default: false },
  team: { type: String, default: '' },
  teamOptions: { type: Array, default: () => [] },
  teamLoading: { type: Boolean, default: false },
  entryAgent: { type: String, default: '' },
  workspaceRoot: { type: String, default: '' },
  entryAgentOptions: { type: Array, default: () => [] },
  entryAgentLoading: { type: Boolean, default: false },
});

const emit = defineEmits([
  'update:modelValue',
  'send',
  'stop',
  'resume',
  'openAttachments',
  'removeAttachment',
  'pasteFiles',
  'update:team',
  'update:entryAgent',
  'update:workspaceRoot',
  'openContextDrawer',
]);

const chatInputRef = ref(null);

const focus = async () => {
  if (chatInputRef.value?.focus) await chatInputRef.value.focus();
};

defineExpose({ focus });
</script>

<style scoped>
.composer-run-controls {
  display: flex;
  min-width: 0;
  flex: 0 1 auto;
  align-items: center;
  gap: 2px;
}

.image-recognition-hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0 auto 8px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--color-border, #444);
  background: var(--color-bg-elevated, #222);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs, 12px);
}

.image-recognition-spinner {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 2px solid var(--color-border-strong, #666);
  border-top-color: var(--color-brand-accent, #4f8cff);
  animation: image-recognition-spin 0.8s linear infinite;
}

@keyframes image-recognition-spin {
  to { transform: rotate(360deg); }
}

.image-recognition-fade-enter-active,
.image-recognition-fade-leave-active {
  transition: opacity 0.2s ease;
}
.image-recognition-fade-enter-from,
.image-recognition-fade-leave-to {
  opacity: 0;
}

.context-usage-content {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  cursor: pointer;
  padding: 4px;
  margin: -4px;
}

.context-usage-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 500;
}

.compressing-indicator {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--color-brand-accent-light);
  margin-left: 6px;
}

.compressing-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-brand-accent-light);
  animation: compressing-pulse 1.2s ease-in-out infinite;
}

@keyframes compressing-pulse {
  0%, 100% { opacity: 0.3; }
  50% { opacity: 1; }
}

@media (max-width: 480px) {
  .composer-run-controls {
    max-width: 220px;
  }

  .context-usage-content {
    flex: 0 0 auto;
  }

  .context-usage-label,
  .compressing-indicator {
    display: none;
  }
}
</style>
