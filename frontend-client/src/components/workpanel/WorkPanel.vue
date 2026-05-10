<template>
  <aside class="work-panel">
    <div class="wp-header">
      <div class="wp-title-block">
        <span class="wp-header-title">工作栏</span>
        <Transition name="wp-label" mode="out-in">
          <span :key="activeRun.active ? 'live' : 'trace'" class="wp-header-subtitle">
            {{ activeRun.active ? '实时执行' : '上下文追踪' }}
          </span>
        </Transition>
      </div>
      <span class="wp-run-pill" :class="{ active: activeRun.active }">
        <span class="wp-run-dot"></span>
        <Transition name="wp-label" mode="out-in">
          <span :key="activeRun.active ? 'running' : 'idle'">{{ activeRun.active ? '运行中' : '待命' }}</span>
        </Transition>
      </span>
    </div>

    <WorkPanelRunStatus
      :phase="activeRun.phase"
      :run-started-at="activeRun.runStartedAt"
      :context-usage="contextUsage"
    />

    <div class="wp-body">
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
          <div class="wp-empty-text">暂无执行记录</div>
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
  messageKey: { type: String, default: '' },
})

const emit = defineEmits(['approvalSubmit', 'userInputSubmit', 'userInputCancel'])
</script>

<style scoped>
.work-panel {
  background:
    linear-gradient(180deg, rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.58), rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.34));
  border-left: 1px solid var(--color-border);
  box-shadow: inset 1px 0 0 rgba(255, 255, 255, 0.02);
  letter-spacing: 0;
}

.wp-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 0 14px;
  height: 56px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.wp-title-block {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wp-header-title {
  font-size: 14px;
  line-height: 1.2;
  font-weight: 650;
  color: var(--color-text-primary);
}

.wp-header-subtitle {
  font-size: 11px;
  line-height: 1.2;
  color: var(--color-text-muted);
}

.wp-run-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 26px;
  padding: 0 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  color: var(--color-text-muted);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
  transition:
    color var(--transition-fast),
    border-color var(--transition-fast),
    background var(--transition-fast),
    box-shadow var(--transition-fast);
}

.wp-run-pill.active {
  color: var(--color-brand-accent);
  border-color: rgba(var(--color-brand-accent-rgb), 0.28);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.05);
}

.wp-run-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: currentColor;
  opacity: 0.72;
  transition: opacity var(--transition-fast), background var(--transition-fast);
}

.wp-run-pill.active .wp-run-dot {
  animation: wp-live-pulse 1.6s ease-in-out infinite;
}

@keyframes wp-live-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.45; transform: scale(0.72); }
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

.wp-label-enter-active,
.wp-label-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.wp-label-enter-from {
  opacity: 0;
  transform: translateY(3px);
}

.wp-label-leave-to {
  opacity: 0;
  transform: translateY(-3px);
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
  .wp-run-pill.active .wp-run-dot {
    animation: none;
  }

  .wp-run-pill,
  .wp-run-dot,
  .wp-label-enter-active,
  .wp-label-leave-active,
  .wp-content-enter-active,
  .wp-content-leave-active,
  .wp-overlay-enter-active,
  .wp-overlay-leave-active {
    transition-duration: 1ms;
  }

  .wp-label-enter-from,
  .wp-label-leave-to,
  .wp-content-enter-from,
  .wp-content-leave-to,
  .wp-overlay-enter-from,
  .wp-overlay-leave-to {
    transform: none;
  }
}
</style>
