<template>
  <aside class="work-panel">
    <!-- Header -->
    <div class="wp-header">
      <span class="wp-header-title">工作栏</span>
    </div>

    <!-- Run status -->
    <WorkPanelRunStatus
      :phase="activeRun.phase"
      :run-started-at="activeRun.runStartedAt"
      :context-usage="contextUsage"
    />

    <!-- Body: execution tree fills space; approval/input float as overlay -->
    <div class="wp-body">
      <!-- Execution timeline -->
      <WorkPanelExecution
        v-if="currentMessage"
        :execution-steps="currentMessage.execution_steps || []"
        :subtasks="currentMessage.subtasks || []"
        :running="activeRun.active"
      />

      <!-- Empty state -->
      <div v-if="!currentMessage && approvalQueue.length === 0 && !pendingUserInput" class="wp-empty">
        <div class="wp-empty-icon">◌</div>
        <div class="wp-empty-text">暂无执行记录</div>
      </div>

      <!-- Overlay: approval / user input — floats at bottom without pushing execution tree -->
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
    </div>
  </aside>
</template>

<script setup>
import WorkPanelRunStatus from './WorkPanelRunStatus.vue'
import WorkPanelExecution from './WorkPanelExecution.vue'
import WorkPanelApproval from './WorkPanelApproval.vue'
import WorkPanelUserInput from './WorkPanelUserInput.vue'

defineProps({
  activeRun: { type: Object, required: true },
  currentMessage: { type: Object, default: null },
  approvalQueue: { type: Array, default: () => [] },
  approvalSubmittingId: { type: String, default: '' },
  pendingUserInput: { type: Object, default: null },
  contextUsage: { type: Object, default: () => ({ used: 0, max: 0 }) },
  sessionId: { type: String, default: '' },
})

const emit = defineEmits(['approvalSubmit', 'userInputSubmit', 'userInputCancel'])
</script>

<style scoped>
.wp-header {
  display: flex;
  align-items: center;
  padding: 0 14px;
  height: 49px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.wp-header-title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--color-text-muted);
}

/* Body takes all remaining height; overlay children are positioned relative to it */
.wp-body {
  flex: 1;
  min-height: 0;
  position: relative;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

/* Approval / UserInput overlay — floats at bottom without affecting execution tree layout */
.wp-overlay-stack {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  /* Fade from transparent to panel background so execution tree shows through */
  background: linear-gradient(to bottom, transparent 0, var(--color-bg-secondary) 20px);
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
  font-size: 22px;
  opacity: 0.4;
}

.wp-empty-text {
  font-size: 12px;
}
</style>
