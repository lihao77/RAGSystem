<template>
  <section class="runtime-section">
    <header class="runtime-section__head">
      <span class="runtime-section__icon" :style="{ color: statusToneColor(goal?.status) }">
        <Target />
      </span>
      <div class="runtime-section__titles">
        <h3 class="runtime-section__title">Goal</h3>
        <p class="runtime-section__subtitle">跨 Run 持续推进的当前目标</p>
      </div>
      <TooltipProvider v-if="goal" :delay-duration="120">
        <Tooltip>
          <TooltipTrigger as-child>
            <span class="runtime-section__status" :class="{ 'is-attention': isAttentionStatus(goal.status) }">
              <span class="status-dot" :style="{ '--dot-color': statusToneColor(goal.status) }" />
              <span v-if="isAttentionStatus(goal.status)" class="runtime-section__status-text">{{ statusMeta.label }}</span>
            </span>
          </TooltipTrigger>
          <TooltipContent>{{ statusMeta.label }}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <Button
        variant="ghost"
        size="icon-sm"
        :disabled="goalState.loading || Boolean(goalState.pendingAction)"
        aria-label="刷新 Goal"
        title="刷新 Goal"
        @click="goalState.loadGoal()"
      >
        <RefreshCw data-icon="inline-start" :class="cn({ 'animate-spin': goalState.loading })" />
      </Button>
    </header>

    <EmptyState
      v-if="goalState.error && !goal"
      row
      tone="error"
      :title="goalState.error"
      class="runtime-empty"
    />

    <EmptyState
      v-else-if="!goal"
      row
      :title="goalState.loading ? '正在加载 Goal' : '当前会话暂无 Goal'"
      class="runtime-empty"
    />

    <div v-else class="runtime-section__body">
      <p class="goal-objective">{{ goal.objective }}</p>

      <div class="goal-meta">
        <span class="goal-meta__chip">{{ progressText }}</span>
        <span class="goal-meta__chip">自动续跑 {{ goal.continuation_count || 0 }} 次</span>
        <span v-if="continuationReasonText" class="goal-meta__chip goal-meta__chip--muted">
          {{ continuationReasonText }}
        </span>
      </div>

      <p v-if="checkpointText" class="goal-checkpoint">{{ checkpointText }}</p>

      <div v-if="steps.length" class="goal-steps">
        <div class="goal-steps__head">
          <span>阶段</span>
          <span>{{ completedSteps }} / {{ steps.length }}</span>
        </div>
        <ol class="goal-steps__list">
          <li
            v-for="(step, index) in steps"
            :key="step.id || index"
            class="goal-step"
            :class="{ 'is-current': step.status === 'in_progress' }"
          >
            <span class="goal-step__marker">
              <Check v-if="step.status === 'completed'" />
              <LoaderCircle v-else-if="step.status === 'in_progress'" class="animate-spin" />
              <span v-else class="goal-step__index">{{ index + 1 }}</span>
            </span>
            <span class="goal-step__copy">
              <strong>{{ stepTitle(step, index) }}</strong>
              <span v-if="step.description && step.description !== stepTitle(step, index)">
                {{ step.description }}
              </span>
            </span>
            <span
              class="goal-step__status"
              :style="{ color: statusToneColor(step.status) }"
              :title="stepStatusLabel(step.status)"
            >
              {{ isAttentionStatus(step.status) ? stepStatusLabel(step.status) : '' }}
            </span>
          </li>
        </ol>
      </div>

      <p v-if="goalState.error" class="runtime-error" role="alert">{{ goalState.error }}</p>
    </div>

    <footer v-if="goal" class="runtime-section__foot">
      <Button
        v-if="goalState.canPause"
        variant="outline"
        size="sm"
        :disabled="Boolean(goalState.pendingAction)"
        @click="goalState.pauseGoal"
      >
        <LoaderCircle v-if="goalState.pendingAction === 'pause'" data-icon="inline-start" class="animate-spin" />
        <Pause v-else data-icon="inline-start" />
        暂停 Goal
      </Button>
      <Button
        v-else-if="goalState.canStart"
        size="sm"
        :disabled="Boolean(goalState.pendingAction)"
        @click="goalState.startGoal"
      >
        <LoaderCircle v-if="goalState.pendingAction === 'start'" data-icon="inline-start" class="animate-spin" />
        <Play v-else data-icon="inline-start" />
        继续 Goal
      </Button>
    </footer>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { Check, LoaderCircle, Pause, Play, RefreshCw, Target } from 'lucide-vue-next';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import EmptyState from '@/components/EmptyState.vue';
import { cn } from '@/lib/utils';
import { statusLabel, statusToneColor } from '@/utils/participantVisual.js';

// 异常/需注意状态才常驻文字,其余只留色点(文字收 Tooltip),与侧栏哲学一致。
const ATTENTION_STATUSES = new Set(['failed', 'blocked', 'interrupted']);
const isAttentionStatus = (status) => ATTENTION_STATUSES.has(status);

const props = defineProps({
  goalState: { type: Object, required: true },
  embedded: { type: Boolean, default: false },
});

const goal = computed(() => props.goalState.goal || null);
const steps = computed(() => (Array.isArray(goal.value?.steps) ? goal.value.steps : []));
const completedSteps = computed(() => steps.value.filter((step) => step.status === 'completed').length);

const statusMeta = computed(() => ({ label: statusLabel(goal.value?.status) }));

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

const stepStatusLabel = (status) => statusLabel(status);

function stepTitle(step, index = 0) {
  return step?.title || step?.subject || step?.description || `阶段 ${index + 1}`;
}
</script>

<style scoped>
.runtime-section {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--color-border);
}

.runtime-section__head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px 10px;
}

.runtime-section__icon {
  display: inline-flex;
  width: 18px;
  height: 18px;
  flex: 0 0 auto;
}

.runtime-section__icon svg {
  width: 100%;
  height: 100%;
}

.runtime-section__titles {
  min-width: 0;
  flex: 1;
}

.runtime-section__title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 650;
  line-height: 1.3;
}

.runtime-section__subtitle {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.runtime-section__status {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.status-dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--dot-color, var(--color-text-muted));
}

.runtime-section__body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 2px 16px 14px;
}

.goal-objective {
  color: var(--color-text-primary);
  font-weight: 650;
  line-height: 1.55;
}

.goal-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.goal-meta__chip {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background: var(--color-hover-overlay);
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
}

.goal-meta__chip--muted {
  color: var(--color-text-muted);
}

.goal-checkpoint {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.goal-steps {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.goal-steps__head {
  display: flex;
  justify-content: space-between;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 650;
  text-transform: uppercase;
}

.goal-steps__list {
  display: flex;
  flex-direction: column;
}

.goal-step {
  display: grid;
  grid-template-columns: 22px minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
  border-bottom: 1px solid var(--color-border);
}

.goal-step:last-child {
  border-bottom: 0;
}

.goal-step__marker {
  display: inline-flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--color-hover-overlay);
  color: var(--color-text-muted);
}

.goal-step.is-current .goal-step__marker {
  color: var(--color-brand-accent);
}

.goal-step__marker svg {
  width: 12px;
  height: 12px;
}

.goal-step__index {
  font-size: 11px;
  font-weight: 650;
}

.goal-step__copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.goal-step__copy strong {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  line-height: 1.35;
}

.goal-step__copy span {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.goal-step__status {
  flex: 0 0 auto;
  font-size: var(--font-size-xs);
}

.runtime-section__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 4px 16px 14px;
}

.runtime-error {
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

.runtime-empty {
  margin: 8px 16px 16px;
}
</style>
