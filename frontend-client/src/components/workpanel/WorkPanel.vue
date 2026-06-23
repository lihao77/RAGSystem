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
      :stopped="Boolean(currentMessage?.stopped)"
    />

    <div class="wp-body">
      <ArtifactPanel
        :message="currentMessage"
        @select="emit('artifactSelect', $event)"
      />

      <Transition name="wp-content" mode="out-in">
        <WorkPanelExecution
          :execution-tree="executionTree"
          :running="activeRun.active"
          :session-id="sessionId"
        />
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
})

const emit = defineEmits(['approvalSubmit', 'userInputSubmit', 'userInputCancel', 'artifactSelect'])

const messageHasError = computed(() => {
  const msg = props.currentMessage
  if (!msg) return false
  if (msg.run_failed) return true
  if (msg.error) return true
  if (String(msg.content || '').includes('[System Error:')) return true
  return false
})

const messageCompleted = computed(() => {
  const msg = props.currentMessage
  return Boolean(msg?.finished && !msg?.stopped && !props.activeRun?.active && !messageHasError.value)
})

const executionTree = computed(() => props.currentMessage?.executionTree || { root: null, steps: [] })

function isErrorStatusItem(item) {
  if (!item) return false
  const type = String(item.type || item.kind || item.status || '').toLowerCase()
  return type === 'error' || type === 'failed'
}
</script>

<style scoped>
.work-panel {
  background: var(--surface-workpanel);
  border-left: 1px solid rgba(var(--color-border-rgb, 255, 255, 255), 0.12);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.04);
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
  z-index: 10;
  padding-top: 22px;
  will-change: transform, opacity;
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
