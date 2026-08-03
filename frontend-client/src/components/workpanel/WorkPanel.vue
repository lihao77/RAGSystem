<template>
  <aside :class="cn('work-panel', { 'work-panel--mobile': mobile })" aria-label="运行中心">
    <BackgroundTasksPanel v-if="activeTab === 'background'" :task-state="taskState" />

    <GoalPanel v-else-if="activeTab === 'goal'" :goal-state="goalState" />

    <div v-else class="runtime-execution-view">
      <WorkPanelRunStatus
        :phase="activeRun.phase"
        :run-started-at="activeRun.runStartedAt"
        :context-usage="contextUsage"
        :pending-input="Boolean(pendingUserInput)"
        :approval-count="approvalQueue.length"
        :running-tool-count="runningToolCount"
        :running-model-count="runningModelCount"
        :has-error="messageHasError"
        :completed="messageCompleted"
        :stopped="Boolean(currentMessage?.stopped)"
      />

      <div class="wp-body">
        <ArtifactPanel
          :message="currentMessage"
          :session-id="sessionId"
          :refresh-key="messageKey"
          :running="activeRun.active"
          @select="emit('artifactSelect', $event)"
          @file-changes="emit('fileChanges')"
        />

        <Transition name="wp-content" mode="out-in">
          <WorkPanelExecution
            :execution-tree="executionTree"
            :injections="currentInjections"
            :running="activeRun.active"
            :session-id="sessionId"
            :message-key="messageKey"
          />
        </Transition>

        <Transition name="wp-overlay">
          <div v-if="pendingUserInput || approvalQueue.length > 0" class="wp-overlay-stack">
            <WorkPanelUserInput
              v-if="pendingUserInput"
              :input-data="pendingUserInput.data"
              :response-allowed="interactionResponseAllowed"
              @submit="emit('userInputSubmit', $event)"
              @cancel="emit('userInputCancel')"
            />
            <WorkPanelApproval
              v-if="approvalQueue.length > 0"
              :queue="approvalQueue"
              :submitting-id="approvalSubmittingId"
              :response-allowed="interactionResponseAllowed"
              @submit="emit('approvalSubmit', $event)"
            />
          </div>
        </Transition>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import WorkPanelRunStatus from './WorkPanelRunStatus.vue'
import WorkPanelExecution from './WorkPanelExecution.vue'
import WorkPanelApproval from './WorkPanelApproval.vue'
import WorkPanelUserInput from './WorkPanelUserInput.vue'
import BackgroundTasksPanel from './BackgroundTasksPanel.vue'
import GoalPanel from './GoalPanel.vue'
import ArtifactPanel from '../chat/ArtifactPanel.vue'

const props = defineProps({
  activeRun: { type: Object, required: true },
  currentMessage: { type: Object, default: null },
  injectionsByRunId: { type: Object, default: () => ({}) },
  messageKey: { type: String, default: '' },
  approvalQueue: { type: Array, default: () => [] },
  approvalSubmittingId: { type: String, default: '' },
  pendingUserInput: { type: Object, default: null },
  interactionResponseAllowed: { type: Boolean, default: false },
  contextUsage: { type: Object, default: () => ({ used: 0, max: 0 }) },
  sessionId: { type: String, default: '' },
  activeTab: { type: String, default: 'execution' },
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
  mobile: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:activeTab',
  'approvalSubmit',
  'userInputSubmit',
  'userInputCancel',
  'artifactSelect',
  'fileChanges',
])

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

const runningToolCount = computed(() => Object.keys(props.activeRun?.runningToolCalls || {}).length)
const runningModelCount = computed(() => Object.keys(props.activeRun?.runningModelCalls || {}).length)

const executionTree = computed(() => props.currentMessage?.executionTree || { root: null, steps: [] })
const currentInjections = computed(() => {
  const runId = props.currentMessage?.run_id || props.currentMessage?.metadata?.run_id
  return runId ? (props.injectionsByRunId[runId] || []) : []
})

</script>

<style scoped>
.work-panel {
  display: flex;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  background: var(--surface-workpanel);
  border-left: 1px solid rgba(var(--color-border-rgb, 255, 255, 255), 0.12);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.04);
  letter-spacing: 0;
}

.work-panel--mobile {
  width: 100%;
  border-left: 0;
  box-shadow: none;
}

.runtime-execution-view {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.work-panel--mobile :deep(.wpr-root),
.work-panel--mobile :deep(.runtime-panel-header) {
  padding-right: 52px;
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
  transition: opacity var(--duration-base) ease, transform var(--duration-base) ease;
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
  transition: opacity var(--duration-base) ease, transform var(--duration-base) cubic-bezier(0.2, 0.8, 0.2, 1);
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
