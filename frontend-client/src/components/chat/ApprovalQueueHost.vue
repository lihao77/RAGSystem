<template>
  <Transition
    :name="disableTransition ? '' : 'work-panel-shell'"
    :css="!disableTransition"
  >
    <WorkPanel
      v-if="isWideScreen && showWorkPanel"
      :active-run="activeRun"
      :current-message="currentMessage"
      :execution-messages="executionMessages"
      :injections-by-run-id="injectionsByRunId"
      :context-usage="contextUsage"
      :session-id="sessionId"
      :message-key="messageKey"
      :active-tab="activeTab"
      :task-state="taskState"
      :goal-state="goalState"
      @update:active-tab="emit('update:activeTab', $event)"
      @file-select="emit('fileSelect', $event)"
      @file-changes="emit('fileChanges')"
      @select-execution-message="emit('selectExecutionMessage', $event)"
    />
  </Transition>

  <Sheet v-if="!isWideScreen" :open="mobileOpen" @update:open="emit('update:mobileOpen', $event)">
    <SheetContent side="right" class="w-[min(92vw,430px)] max-w-none p-0 sm:max-w-[430px]">
      <SheetHeader class="sr-only">
        <SheetTitle>运行中心</SheetTitle>
        <SheetDescription>查看执行过程、后台任务与当前 Goal</SheetDescription>
      </SheetHeader>
      <WorkPanel
        mobile
        :active-run="activeRun"
        :current-message="currentMessage"
        :execution-messages="executionMessages"
        :injections-by-run-id="injectionsByRunId"
        :context-usage="contextUsage"
        :session-id="sessionId"
        :message-key="messageKey"
        :active-tab="activeTab"
        :task-state="taskState"
        :goal-state="goalState"
        @update:active-tab="emit('update:activeTab', $event)"
        @file-select="emit('fileSelect', $event)"
        @file-changes="emit('fileChanges')"
        @select-execution-message="emit('selectExecutionMessage', $event)"
      />
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
  showWorkPanel: { type: Boolean, default: false },
  activeRun: { type: Object, required: true },
  currentMessage: { type: Object, default: null },
  executionMessages: { type: Array, default: () => [] },
  injectionsByRunId: { type: Object, default: () => ({}) },
  contextUsage: { type: Object, default: () => ({ used: 0, max: 0 }) },
  sessionId: { type: String, default: '' },
  messageKey: { type: String, default: '' },
  disableTransition: { type: Boolean, default: false },
  isWideScreen: { type: Boolean, default: false },
  mobileOpen: { type: Boolean, default: false },
  activeTab: { type: String, default: 'execution' },
  taskState: { type: Object, required: true },
  goalState: { type: Object, required: true },
});

const emit = defineEmits([
  'update:mobileOpen',
  'update:activeTab',
  'fileSelect',
  'fileChanges',
  'selectExecutionMessage',
]);

</script>

<style scoped>
.work-panel-shell-enter-active,
.work-panel-shell-leave-active {
  transition:
    width 420ms var(--ease-out-expo),
    opacity 300ms ease,
    transform 420ms var(--ease-out-expo);
  overflow: hidden;
}

.work-panel-shell-enter-from,
.work-panel-shell-leave-to {
  width: 0 !important;
  opacity: 0;
  transform: translateX(36px);
}

@media (prefers-reduced-motion: reduce) {
  .work-panel-shell-enter-active,
  .work-panel-shell-leave-active {
    transition: none !important;
  }
}
</style>
