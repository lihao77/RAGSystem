<template>
  <div class="runtime-overview">
    <GoalPanel v-if="showGoalSection" :goal-state="goalState" />
    <div v-if="showGoalSection && showTaskSection" class="runtime-overview__divider" />
    <BackgroundTasksPanel v-if="showTaskSection" :task-state="taskState" />
    <p v-if="!showGoalSection && !showTaskSection" class="runtime-overview__empty">
      当前没有运行中的目标或后台任务
    </p>
  </div>
</template>

<script setup>
import { computed } from 'vue';
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
</script>

<style scoped>
.runtime-overview {
  display: flex;
  min-width: 0;
  flex-direction: column;
}

.runtime-overview__divider {
  height: 1px;
  margin: 0 16px;
  background: var(--color-border);
}

.runtime-overview__empty {
  padding: 20px 16px;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  text-align: center;
}
</style>
