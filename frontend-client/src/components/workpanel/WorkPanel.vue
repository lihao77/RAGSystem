<template>
  <aside class="work-panel">
    <WorkPanelRunStatus
      :phase="activeRun.phase"
      :run-started-at="activeRun.runStartedAt"
      :context-usage="contextUsage"
      :pending-input="Boolean(pendingUserInput)"
      :approval-count="approvalQueue.length"
      :has-error="messageHasError"
      :completed="messageCompleted"
    />

    <div class="wp-body">
      <ArtifactPanel
        :message="currentMessage"
        @select="emit('artifactSelect', $event)"
      />

      <Transition name="wp-content" mode="out-in">
        <WorkPanelExecution
          v-if="currentMessage"
          :key="messageKey"
          :execution-steps="currentMessage.execution_steps || []"
          :subtasks="currentMessage.subtasks || []"
          :running="activeRun.active"
          :session-id="sessionId"
        />

        <div v-else-if="approvalQueue.length === 0 && !pendingUserInput" class="wp-empty">
          <div class="wp-empty-icon" aria-hidden="true"></div>
          <div class="wp-empty-text">{{ emptyStateText }}</div>
        </div>
      </Transition>

      <Transition name="wp-overlay">
        <div v-if="pendingUserInput || approvalQueue.length > 0" class="wp-overlay-stack">
        <WorkPanelUserInput
          v-if="pendingUserInput"
          :input-data="pendingUserInput.data"
          @submit="emit('userInputSubmit', $event)"
          @cancel="emit('userInputCancel')"
        />
        <WorkPanelApproval
          v-if="approvalQueue.length > 0"
          :queue="approvalQueue"
          :submitting-id="approvalSubmittingId"
          @submit="emit('approvalSubmit', $event)"
        />
        </div>
      </Transition>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import WorkPanelRunStatus from './WorkPanelRunStatus.vue'
import WorkPanelExecution from './WorkPanelExecution.vue'
import WorkPanelApproval from './WorkPanelApproval.vue'
import WorkPanelUserInput from './WorkPanelUserInput.vue'
import ArtifactPanel from '../chat/ArtifactPanel.vue'

const props = defineProps({
  activeRun: { type: Object, required: true },
  currentMessage: { type: Object, default: null },
  approvalQueue: { type: Array, default: () => [] },
  approvalSubmittingId: { type: String, default: '' },
  pendingUserInput: { type: Object, default: null },
  contextUsage: { type: Object, default: () => ({ used: 0, max: 0 }) },
  sessionId: { type: String, default: '' },
  messageKey: { type: String, default: '' },
})

const emit = defineEmits(['approvalSubmit', 'userInputSubmit', 'userInputCancel', 'artifactSelect'])

const messageHasError = computed(() => {
  const msg = props.currentMessage
  if (!msg) return false
  if (msg.error) return true
  if (String(msg.content || '').includes('[System Error:')) return true
  if (Array.isArray(msg.status) && msg.status.some(isErrorStatusItem)) return true
  return hasErrorInItems(msg.execution_steps) || hasErrorInItems(msg.subtasks)
})

const messageCompleted = computed(() => {
  const msg = props.currentMessage
  return Boolean(msg?.finished && !props.activeRun?.active && !messageHasError.value)
})

const emptyStateText = computed(() => props.sessionId ? '暂无执行记录' : '等待第一条任务')

function isErrorStatusItem(item) {
  if (!item) return false
  const type = String(item.type || item.kind || item.status || '').toLowerCase()
  return type === 'error' || type === 'failed'
}

function hasErrorInItems(items) {
  if (!Array.isArray(items)) return false
  return items.some((item) => {
    if (!item || typeof item !== 'object') return false
    const status = String(item.status || item.run_status || item.phase || '').toLowerCase()
    if (status === 'error' || status === 'failed') return true
    if (item.error || item.error_message) return true
    return hasErrorInItems(item.children)
      || hasErrorInItems(item.subtasks)
      || hasErrorInItems(item.execution_steps)
      || hasErrorInItems(item.steps)
  })
}
</script>

<style scoped>
.work-panel {
  background:
    linear-gradient(180deg, rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.58), rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.34));
  border-left: 1px solid var(--color-border);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.02);
  letter-spacing: 0;
}

.wp-body {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.wp-overlay-stack {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding-top: 22px;
  background: linear-gradient(
    to bottom,
    transparent 0,
    rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.84) 22px,
    rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.96) 100%
  );
  backdrop-filter: blur(16px) saturate(140%);
  -webkit-backdrop-filter: blur(16px) saturate(140%);
  will-change: transform, opacity;
}

.wp-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--color-text-muted);
}

.wp-empty-icon {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: 1px solid var(--color-border);
  position: relative;
  opacity: 0.72;
}

.wp-empty-icon::after {
  content: '';
  position: absolute;
  inset: 9px;
  border-radius: 50%;
  background: var(--color-border);
}

.wp-empty-text {
  font-size: 12px;
}

.wp-content-enter-active,
.wp-content-leave-active {
  transition: opacity 180ms ease, transform 180ms ease;
}

.wp-content-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.wp-content-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}

.wp-overlay-enter-active,
.wp-overlay-leave-active {
  transition: opacity 180ms ease, transform 180ms cubic-bezier(0.2, 0.8, 0.2, 1);
}

.wp-overlay-enter-from,
.wp-overlay-leave-to {
  opacity: 0;
  transform: translateY(14px);
}

@media (prefers-reduced-motion: reduce) {
  .wp-content-enter-active,
  .wp-content-leave-active,
  .wp-overlay-enter-active,
  .wp-overlay-leave-active {
    transition-duration: 1ms;
  }

  .wp-content-enter-from,
  .wp-content-leave-to,
  .wp-overlay-enter-from,
  .wp-overlay-leave-to {
    transform: none;
  }
}
</style>
