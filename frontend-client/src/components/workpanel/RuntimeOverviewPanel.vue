<template>
  <div class="runtime-overview">
    <div class="runtime-overview-scroll">
      <GoalPanel v-if="showGoalSection" embedded :goal-state="goalState" />

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
import { computed } from 'vue';
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
</script>

<style scoped>
.runtime-overview {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
}

.runtime-overview-scroll {
  display: flex;
  min-height: 0;
  flex: 1;
  flex-direction: column;
  overflow-y: auto;
}

.runtime-overview-empty {
  margin: auto 16px;
}
</style>
