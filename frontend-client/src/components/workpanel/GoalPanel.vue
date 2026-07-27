<template>
  <section class="runtime-tab-panel">
    <div class="runtime-panel-header">
      <div class="flex min-w-0 items-center gap-2">
        <Target class="size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div class="min-w-0">
          <h3 class="runtime-panel-title">Goal</h3>
          <p class="runtime-panel-subtitle">跨 Run 持续推进的当前目标</p>
        </div>
      </div>
      <div class="flex items-center gap-2">
        <Badge v-if="goal" :variant="statusMeta.variant">{{ statusMeta.label }}</Badge>
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
      </div>
    </div>

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

    <div v-else class="runtime-panel-scroll">
      <div class="goal-summary">
        <p class="goal-objective">{{ goal.objective }}</p>
        <div class="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{{ progressText }}</Badge>
          <Badge variant="secondary">自动续跑 {{ goal.continuation_count || 0 }} 次</Badge>
        </div>
        <div v-if="continuationReasonText" class="goal-continuation-reason" role="status">
          <span class="goal-section-label">续跑状态</span>
          <span>{{ continuationReasonText }}</span>
        </div>
        <p v-if="checkpointText" class="goal-checkpoint">{{ checkpointText }}</p>
      </div>

      <div v-if="currentStep" class="goal-current-step">
        <span class="goal-section-label">当前阶段</span>
        <strong>{{ stepTitle(currentStep) }}</strong>
        <span v-if="currentStep.description && currentStep.description !== stepTitle(currentStep)">{{ currentStep.description }}</span>
      </div>

      <div v-if="steps.length" class="goal-steps">
        <div class="goal-steps-heading">
          <span class="goal-section-label">阶段</span>
          <span>{{ completedSteps }} / {{ steps.length }}</span>
        </div>
        <ol class="goal-step-list">
          <li v-for="(step, index) in steps" :key="step.id || index" class="goal-step-item">
            <span class="goal-step-index">{{ index + 1 }}</span>
            <span class="goal-step-copy">
              <strong>{{ stepTitle(step, index) }}</strong>
              <span v-if="step.description && step.description !== stepTitle(step, index)">{{ step.description }}</span>
            </span>
            <Badge :variant="stepStatusMeta(step.status).variant">
              {{ stepStatusMeta(step.status).label }}
            </Badge>
          </li>
        </ol>
      </div>

      <p v-if="goalState.error" class="runtime-error" role="alert">{{ goalState.error }}</p>
    </div>

    <div v-if="goal" class="runtime-panel-footer">
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
    </div>
  </section>
</template>

<script setup>
import { computed } from 'vue';
import { LoaderCircle, Pause, Play, RefreshCw, Target } from 'lucide-vue-next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import EmptyState from '@/components/EmptyState.vue';
import { cn } from '@/lib/utils';

const props = defineProps({
  goalState: { type: Object, required: true },
});

const goal = computed(() => props.goalState.goal || null);
const steps = computed(() => Array.isArray(goal.value?.steps) ? goal.value.steps : []);
const completedSteps = computed(() => steps.value.filter((step) => step.status === 'completed').length);
const currentStep = computed(() => (
  steps.value.find((step) => step.status === 'in_progress')
  || steps.value.find((step) => step.status === 'pending')
  || null
));

const statusMeta = computed(() => ({
  active: { label: '进行中', variant: 'success' },
  paused: { label: '已暂停', variant: 'warning' },
  completed: { label: '已完成', variant: 'secondary' },
  blocked: { label: '已阻塞', variant: 'destructive' },
}[goal.value?.status] || { label: goal.value?.status || '未知', variant: 'outline' }));

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

function stepStatusMeta(status) {
  return ({
    completed: { label: '完成', variant: 'success' },
    in_progress: { label: '进行中', variant: 'default' },
    blocked: { label: '阻塞', variant: 'destructive' },
    pending: { label: '待执行', variant: 'outline' },
  }[status] || { label: status || '待执行', variant: 'outline' });
}

function stepTitle(step, index = 0) {
  return step?.title || step?.subject || step?.description || `阶段 ${index + 1}`;
}
</script>

<style scoped>
.runtime-tab-panel {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow: hidden;
}

.runtime-panel-header,
.runtime-panel-footer {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--color-border);
}

.runtime-panel-footer {
  justify-content: flex-end;
  border-top: 1px solid var(--color-border);
  border-bottom: 0;
}

.runtime-panel-title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 650;
}

.runtime-panel-subtitle,
.goal-checkpoint,
.goal-current-step span,
.goal-step-copy span,
.goal-steps-heading {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.runtime-panel-scroll {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  gap: 12px;
  overflow-y: auto;
  padding: 14px;
}

.goal-summary,
.goal-current-step {
  display: flex;
  flex-direction: column;
  gap: 8px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  padding: 12px;
  background: var(--surface-shell);
}

.goal-objective {
  color: var(--color-text-primary);
  line-height: 1.55;
  font-weight: 650;
}

.goal-continuation-reason {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.goal-section-label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 650;
  text-transform: uppercase;
}

.goal-steps {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.goal-steps-heading {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}

.goal-step-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.goal-step-item {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr) auto;
  align-items: start;
  gap: 8px;
  padding: 9px 0;
  border-bottom: 1px solid var(--color-border);
}

.goal-step-index {
  display: inline-flex;
  size: 24px;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--color-bg-secondary);
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 650;
}

.goal-step-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}

.goal-step-copy strong,
.goal-current-step strong {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  line-height: 1.35;
}

.runtime-error {
  color: var(--color-error);
  font-size: var(--font-size-xs);
}

.runtime-empty {
  margin: 14px;
}
</style>
