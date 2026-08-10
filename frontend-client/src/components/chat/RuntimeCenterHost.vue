<template>
  <Sheet :open="open" @update:open="emit('update:open', $event)">
    <SheetContent side="right" class="flex w-[min(92vw,460px)] max-w-none flex-col gap-0 p-0 sm:max-w-[460px]">
      <SheetHeader class="sr-only">
        <SheetTitle>运行中心</SheetTitle>
        <SheetDescription>管理当前 Goal 和后台任务</SheetDescription>
      </SheetHeader>
      <WorkPanel :task-state="taskState" :goal-state="goalState" />
    </SheetContent>
  </Sheet>
</template>

<script setup>
import WorkPanel from '../workpanel/WorkPanel.vue';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '../ui/sheet';

defineProps({
  open: { type: Boolean, default: false },
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
});

const emit = defineEmits(['update:open']);
</script>
