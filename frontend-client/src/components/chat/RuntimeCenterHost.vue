<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="flex w-[min(92vw,420px)] max-w-none flex-col gap-0 p-0 sm:max-w-[420px]">
      <SheetHeader class="runtime-center-head">
        <div class="runtime-center-head__titles">
          <SheetTitle class="runtime-center-head__title">运行中心</SheetTitle>
          <SheetDescription class="runtime-center-head__subtitle">持续目标与后台任务</SheetDescription>
        </div>
        <div v-if="statusChips.length" class="runtime-center-head__chips">
          <span v-for="chip in statusChips" :key="chip.label" class="runtime-center-chip">
            <span class="runtime-center-chip__dot" :style="{ '--dot-color': chip.color }" />
            {{ chip.label }}
          </span>
        </div>
      </SheetHeader>
      <WorkPanel :task-state="taskState" :goal-state="goalState" />
    </SheetContent>
  </Sheet>
</template>

<script setup>
import { computed } from 'vue';
import WorkPanel from '../workpanel/WorkPanel.vue';
import { statusToneColor } from '@/utils/participantVisual.js';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../ui/sheet';

const props = defineProps({
  open: { type: Boolean, default: false },
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
});

const emit = defineEmits(['update:open']);

const goalLabel = computed(() => ({
  active: '进行中',
  paused: '已暂停',
  completed: '已完成',
  blocked: '已阻塞',
}[props.goalState.goal?.status] || '未知'));

const statusChips = computed(() => {
  const chips = [];
  if (props.goalState.goal) {
    chips.push({ label: `Goal ${goalLabel.value}`, color: statusToneColor(props.goalState.goal.status) });
  }
  if (props.taskState.runningCount) {
    chips.push({ label: `${props.taskState.runningCount} 个后台任务`, color: statusToneColor('running') });
  }
  return chips;
});
</script>

<style scoped>
.runtime-center-head {
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  /* 右侧为 Sheet 绝对定位的关闭按钮(right-4 top-4)让位 */
  padding: 16px 48px 12px 16px;
  border-bottom: 1px solid var(--color-border);
  text-align: left;
}

.runtime-center-head__titles {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.runtime-center-head__title {
  font-size: var(--font-size-base);
  font-weight: 650;
}

.runtime-center-head__subtitle {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
}

.runtime-center-head__chips {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  padding-top: 2px;
}

.runtime-center-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
  white-space: nowrap;
}

.runtime-center-chip__dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--dot-color, var(--color-text-muted));
}
</style>
