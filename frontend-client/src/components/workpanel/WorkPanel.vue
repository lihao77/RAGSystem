<template>
  <aside class="work-panel" aria-label="运行中心">
    <RuntimeOverviewPanel :task-state="taskState" :goal-state="goalState" />
  </aside>
</template>

<script setup>
import RuntimeOverviewPanel from './RuntimeOverviewPanel.vue';

defineProps({
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
});
</script>

<style scoped>
.work-panel {
  display: flex;
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  min-height: 0;
  height: 100%;
  flex-direction: column;
  overflow: hidden;
  background: var(--surface-workpanel);
  letter-spacing: 0;
}
</style>
