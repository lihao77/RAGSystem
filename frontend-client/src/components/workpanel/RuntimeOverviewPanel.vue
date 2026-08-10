<template>
  <div class="runtime-overview">
    <header class="runtime-overview-header">
      <div class="flex min-w-0 items-center gap-3">
        <span class="runtime-overview-icon" aria-hidden="true">
          <Activity />
        </span>
        <div class="min-w-0">
          <h2 class="runtime-overview-title">运行中心</h2>
          <p class="runtime-overview-subtitle">持续目标与后台任务</p>
        </div>
      </div>
      <div class="runtime-overview-badges">
        <Badge v-if="goalState.goal" :variant="goalBadge.variant">{{ goalBadge.label }}</Badge>
        <Badge v-if="taskState.runningCount" variant="secondary">
          {{ taskState.runningCount }} 个后台任务
        </Badge>
      </div>
    </header>

    <div class="runtime-overview-scroll">
      <GoalPanel v-if="showGoalSection" embedded :goal-state="goalState" />

      <Separator v-if="showGoalSection && showTaskSection" />
      <BackgroundTasksPanel v-if="showTaskSection" embedded :task-state="taskState" />

      <EmptyState
        v-if="!showGoalSection && !showTaskSection"
        title="当前没有需要管理的运行"
        hint="持续目标或后台任务出现后会显示在这里"
        class="runtime-overview-empty"
      />
    </div>
  </div>
</template>

<script setup>
import { Activity } from 'lucide-vue-next';
import { computed } from 'vue';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import EmptyState from '@/components/EmptyState.vue';
import BackgroundTasksPanel from './BackgroundTasksPanel.vue';
import GoalPanel from './GoalPanel.vue';

const props = defineProps({
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
});

const showGoalSection = computed(() => Boolean(
  props.goalState.goal || props.goalState.loading || props.goalState.error,
));
const showTaskSection = computed(() => Boolean(
  props.taskState.tasks?.length || props.taskState.loading || props.taskState.error,
));
const goalBadge = computed(() => ({
  active: { label: 'Goal 进行中', variant: 'success' },
  paused: { label: 'Goal 已暂停', variant: 'warning' },
  completed: { label: 'Goal 已完成', variant: 'secondary' },
  blocked: { label: 'Goal 已阻塞', variant: 'destructive' },
}[props.goalState.goal?.status] || { label: 'Goal', variant: 'outline' }));
</script>

<style scoped>
.runtime-overview {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.runtime-overview-header {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 64px;
  padding: 12px 52px 12px 14px;
  border-bottom: 1px solid var(--color-border);
}

.runtime-overview-icon {
  display: inline-flex;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-secondary);
  background: var(--surface-shell);
}

.runtime-overview-icon svg {
  width: 17px;
  height: 17px;
}

.runtime-overview-title {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 700;
  line-height: 1.3;
}

.runtime-overview-subtitle {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.runtime-overview-badges {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.runtime-overview-scroll {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow-y: auto;
}

.runtime-overview-empty {
  margin: auto 14px;
}

@media (max-width: 480px) {
  .runtime-overview-header {
    align-items: flex-start;
  }

  .runtime-overview-badges {
    max-width: 120px;
  }
}
</style>
