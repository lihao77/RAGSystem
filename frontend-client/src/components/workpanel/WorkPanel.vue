<template>
  <aside :class="cn('work-panel', { 'work-panel--mobile': mobile })" aria-label="运行中心">
    <BackgroundTasksPanel v-if="activeTab === 'background'" :task-state="taskState" />

    <GoalPanel v-else-if="activeTab === 'goal'" :goal-state="goalState" />

    <div v-else class="runtime-execution-view">
      <div v-if="executionMessages.length > 1" class="wp-run-select">
        <Select :model-value="messageKey" @update:model-value="emit('selectExecutionMessage', $event)">
          <SelectTrigger aria-label="选择 Run">
            <SelectValue placeholder="选择 Run" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem
                v-for="(item, index) in executionMessages"
                :key="item.key"
                :value="item.key"
              >
                {{ runOptionLabel(item, index) }}
              </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      <WorkPanelRunStatus
        :phase="activeRun.phase"
        :run-started-at="activeRun.runStartedAt"
        :context-usage="contextUsage"
        :running-tool-count="runningToolCount"
        :running-model-count="runningModelCount"
        :has-error="messageHasError"
        :interrupted="messageInterrupted"
        :completed="messageCompleted"
      />

      <div class="wp-body">
        <FileOutputPanel
          :message="currentMessage"
          :session-id="sessionId"
          :refresh-key="messageKey"
          :message-key="messageKey"
          :running="activeRun.active"
          @select="emit('fileSelect', $event)"
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

      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue'
import { cn } from '@/lib/utils'
import WorkPanelRunStatus from './WorkPanelRunStatus.vue'
import WorkPanelExecution from './WorkPanelExecution.vue'
import BackgroundTasksPanel from './BackgroundTasksPanel.vue'
import GoalPanel from './GoalPanel.vue'
import FileOutputPanel from '../chat/FileOutputPanel.vue'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

const props = defineProps({
  activeRun: { type: Object, required: true },
  currentMessage: { type: Object, default: null },
  executionMessages: { type: Array, default: () => [] },
  injectionsByRunId: { type: Object, default: () => ({}) },
  messageKey: { type: String, default: '' },
  contextUsage: { type: Object, default: () => ({ used: 0, max: 0 }) },
  sessionId: { type: String, default: '' },
  activeTab: { type: String, default: 'execution' },
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
  mobile: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:activeTab',
  'fileSelect',
  'fileChanges',
  'selectExecutionMessage',
])

const runOptionLabel = (item, index) => {
  const message = item?.message || {}
  const runId = message.run_id || message.metadata?.run_id || ''
  const status = message.finished === false ? '运行中' : message.run_failed ? '失败' : message.stopped ? '已停止' : '已完成'
  return `Run ${index + 1}${runId ? ` · ${runId.slice(0, 8)}` : ''} · ${status}`
}

const messageHasError = computed(() => {
  const msg = props.currentMessage
  if (!msg) return false
  if (msg.run_failed) return true
  if (msg.error) return true
  if (String(msg.content || '').includes('[System Error:')) return true
  return false
})

const messageInterrupted = computed(() => {
  const msg = props.currentMessage
  return Boolean(
    msg?.stopped
    || msg?.metadata?.interrupted
    || msg?.metadata?.terminal_status === 'interrupted',
  )
})

const messageCompleted = computed(() => {
  const msg = props.currentMessage
  return Boolean(
    msg?.finished
    && !messageInterrupted.value
    && !props.activeRun?.active
    && !messageHasError.value,
  )
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

.wp-run-select {
  flex: 0 0 auto;
  padding: 10px 12px 0;
}

.wp-run-select :deep(button) {
  width: 100%;
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

@media (prefers-reduced-motion: reduce) {
  .wp-content-enter-active,
  .wp-content-leave-active {
    transition-duration: 1ms;
  }

  .wp-content-enter-from,
  .wp-content-leave-to {
    transform: none;
  }
}
</style>
