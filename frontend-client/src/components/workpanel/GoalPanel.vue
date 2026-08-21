<template>
  <section class="goal-panel" aria-label="目标">
    <div class="goal-panel__bar">
      <span class="panel-label">目标</span>
      <span v-if="goal" class="goal-status" :style="{ '--tone': statusToneColor(goal.status) }">
        <span class="goal-status__dot" :class="{ 'is-live': goal.status === 'active' }" />
        {{ goalStatusLabel(goal.status) }}
      </span>
      <button
        type="button"
        class="icon-btn"
        :disabled="goalState.loading || Boolean(goalState.pendingAction)"
        aria-label="刷新目标"
        title="刷新目标"
        @click="goalState.loadGoal()"
      >
        <RefreshCw :class="{ spin: goalState.loading }" />
      </button>
    </div>

    <p v-if="goalState.error && !goal" class="panel-note panel-note--error" role="alert">{{ goalState.error }}</p>
    <p v-else-if="!goal" class="panel-note">{{ goalState.loading ? '正在加载目标…' : '当前会话暂无目标' }}</p>

    <template v-else>
      <p class="goal-objective">{{ goal.objective }}</p>

      <div v-if="steps.length" class="goal-progress">
        <div class="goal-progress__track" role="progressbar" :aria-valuenow="completedSteps" :aria-valuemax="steps.length">
          <i class="goal-progress__fill" :style="{ width: `${progressPct}%` }" />
        </div>
        <span class="goal-progress__text">{{ completedSteps }}/{{ steps.length }} 阶段</span>
      </div>
      <p v-else class="goal-progress-alone">{{ progressText }}</p>

      <p class="goal-meta">
        自动续跑 {{ goal.continuation_count || 0 }} 次<template v-if="continuationReasonText"> · {{ continuationReasonText }}</template>
      </p>
      <p v-if="checkpointText" class="goal-checkpoint">{{ checkpointText }}</p>

      <ol v-if="steps.length" class="goal-steps">
        <li
          v-for="(step, index) in steps"
          :key="step.id || index"
          class="goal-step"
          :class="{ 'is-current': step.status === 'in_progress' }"
        >
          <span class="goal-step__marker" aria-hidden="true">
            <Check v-if="step.status === 'completed'" />
            <LoaderCircle v-else-if="step.status === 'in_progress'" class="spin" />
            <span v-else class="goal-step__index">{{ index + 1 }}</span>
          </span>
          <span class="goal-step__title" :title="step.description && step.description !== stepTitle(step, index) ? step.description : undefined">
            {{ stepTitle(step, index) }}
          </span>
          <span
            v-if="isAttentionStatus(step.status)"
            class="goal-step__status"
            :style="{ color: statusToneColor(step.status) }"
          >
            {{ statusLabel(step.status) }}
          </span>
        </li>
      </ol>

      <div v-if="goalState.canPause || goalState.canStart" class="goal-actions">
        <button
          v-if="goalState.canPause"
          type="button"
          class="goal-btn"
          :disabled="Boolean(goalState.pendingAction)"
          @click="goalState.pauseGoal"
        >
          <LoaderCircle v-if="goalState.pendingAction === 'pause'" class="spin" />
          <Pause v-else />
          暂停
        </button>
        <button
          v-else-if="goalState.canStart"
          type="button"
          class="goal-btn goal-btn--primary"
          :disabled="Boolean(goalState.pendingAction)"
          @click="goalState.startGoal"
        >
          <LoaderCircle v-if="goalState.pendingAction === 'start'" class="spin" />
          <Play v-else />
          继续
        </button>
      </div>

      <p v-if="goalState.error" class="panel-note panel-note--error" role="alert">{{ goalState.error }}</p>
    </template>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { Check, LoaderCircle, Pause, Play, RefreshCw } from 'lucide-vue-next';
import { statusLabel, statusToneColor } from '@/utils/participantVisual.js';

// 阶段/目标的异常状态才亮文字,其余由标记与色点表达。
const ATTENTION_STATUSES = new Set(['failed', 'blocked', 'interrupted']);
const isAttentionStatus = (status) => ATTENTION_STATUSES.has(status);

const props = defineProps({
  goalState: { type: Object, required: true },
});

const goal = computed(() => props.goalState.goal || null);
const steps = computed(() => (Array.isArray(goal.value?.steps) ? goal.value.steps : []));
const completedSteps = computed(() => steps.value.filter((step) => step.status === 'completed').length);
const progressPct = computed(() => (
  steps.value.length ? Math.round((completedSteps.value / steps.value.length) * 100) : 0
));

// 通用 statusLabel 把 active 译作"就绪",目标语境下应为"进行中"。
const goalStatusLabel = (status) => ({
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  blocked: '已阻塞',
  failed: '失败',
}[status] || statusLabel(status));

const progressText = computed(() => {
  if (steps.value.length) return `${completedSteps.value} / ${steps.value.length} 阶段完成`;
  const progress = goal.value?.progress ?? goal.value?.checkpoint;
  if (typeof progress === 'number') {
    const percentage = progress <= 1 ? progress * 100 : progress;
    return `进度 ${Math.max(0, Math.min(100, Math.round(percentage)))}%`;
  }
  return '等待阶段进度';
});

const continuationReasonText = computed(() => ({
  manual_paused: '已手动暂停',
  run_still_running: '等待当前 Run 完成',
  background_tasks_running: '等待后台任务完成',
  goal_not_active: 'Goal 当前不可续跑',
  readiness_failed: 'Agent 或模型配置未就绪',
  max_continuations: '已达到自动续跑上限',
  no_progress_guard: '连续无进展，已触发保护',
  continuation_pending: '续跑请求正在处理中',
  continuation_start_failed: '续跑启动失败，将在下次空闲时重试',
}[goal.value?.continuation_reason] || ''));

const checkpointText = computed(() => {
  const checkpoint = goal.value?.checkpoint ?? goal.value?.progress;
  if (typeof checkpoint === 'string') return checkpoint;
  if (checkpoint && typeof checkpoint === 'object') {
    return checkpoint.summary || checkpoint.description || checkpoint.current_step || '';
  }
  return '';
});

function stepTitle(step, index = 0) {
  return step?.title || step?.subject || step?.description || `阶段 ${index + 1}`;
}
</script>

<style scoped>
/* 目标面板:眉题 + 状态丸 + 进度条,不再用分区卡片大标题 */
.goal-panel {
  display: flex;
  flex-direction: column;
  padding: 12px 16px 14px;
}

.goal-panel__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.panel-label {
  color: var(--color-text-muted);
  font-size: 11px;
  font-weight: 650;
  letter-spacing: 0.06em;
}

.goal-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--tone) 12%, transparent);
  color: var(--tone);
  font-size: 11px;
  font-weight: 650;
  line-height: 1.5;
}

.goal-status__dot {
  width: 5px;
  height: 5px;
  border-radius: var(--radius-full);
  background: currentColor;
}

.goal-status__dot.is-live {
  animation: goal-dot-pulse 1.6s var(--ease-default) infinite;
}

.icon-btn {
  display: inline-flex;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  margin-left: auto;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.icon-btn:hover:not(:disabled) {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.icon-btn:disabled {
  cursor: default;
  opacity: 0.5;
}

.icon-btn svg {
  width: 13px;
  height: 13px;
}

.panel-note {
  padding: 4px 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.panel-note--error {
  color: var(--color-error);
}

.goal-objective {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 1.55;
}

.goal-progress {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.goal-progress__track {
  height: 4px;
  min-width: 0;
  flex: 1;
  overflow: hidden;
  border-radius: var(--radius-full);
  background: var(--color-hover-overlay-md);
}

.goal-progress__fill {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--color-brand-accent);
  transition: width var(--duration-slow) var(--ease-default);
}

.goal-progress__text {
  flex: 0 0 auto;
  color: var(--color-text-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}

.goal-progress-alone {
  margin-top: 6px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.goal-meta {
  margin-top: 8px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.goal-checkpoint {
  margin-top: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

.goal-steps {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-top: 10px;
}

.goal-step {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 3px 0;
}

.goal-step__marker {
  display: inline-flex;
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  color: var(--color-text-muted);
}

.goal-step__marker svg {
  width: 11px;
  height: 11px;
}

.goal-step.is-current .goal-step__marker {
  color: var(--color-brand-accent);
}

.goal-step__index {
  font-size: 10px;
  font-weight: 650;
}

.goal-step__title {
  min-width: 0;
  flex: 1;
  overflow: hidden;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.goal-step.is-current .goal-step__title {
  color: var(--color-text-primary);
}

.goal-step__status {
  flex: 0 0 auto;
  font-size: 11px;
}

.goal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}

.goal-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  cursor: pointer;
  transition: background var(--duration-fast) var(--ease-default), color var(--duration-fast) var(--ease-default);
}

.goal-btn:hover:not(:disabled) {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.goal-btn--primary {
  border-color: color-mix(in srgb, var(--color-brand-accent) 35%, transparent);
  background: color-mix(in srgb, var(--color-brand-accent) 12%, transparent);
  color: var(--color-brand-accent);
}

.goal-btn--primary:hover:not(:disabled) {
  background: color-mix(in srgb, var(--color-brand-accent) 18%, transparent);
  color: var(--color-brand-accent);
}

.goal-btn:disabled {
  cursor: default;
  opacity: 0.55;
}

.goal-btn svg {
  width: 12px;
  height: 12px;
}

.spin {
  animation: goal-spin 1s linear infinite;
}

@keyframes goal-spin {
  to { transform: rotate(360deg); }
}

@keyframes goal-dot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, currentColor 40%, transparent); }
  50% { box-shadow: 0 0 0 3px transparent; }
}

@media (prefers-reduced-motion: reduce) {
  .spin,
  .goal-status__dot.is-live {
    animation: none;
  }

  .goal-progress__fill {
    transition: none;
  }
}
</style>
