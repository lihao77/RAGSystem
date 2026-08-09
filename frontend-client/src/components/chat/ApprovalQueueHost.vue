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
      :approval-queue="approvalQueue"
      :approval-submitting-id="approvalSubmittingId"
      :pending-user-input="pendingUserInput"
      :interaction-response-allowed="interactionResponseAllowed"
      :context-usage="contextUsage"
      :session-id="sessionId"
      :message-key="messageKey"
      :active-tab="activeTab"
      :task-state="taskState"
      :goal-state="goalState"
      @update:active-tab="emit('update:activeTab', $event)"
      @approval-submit="emit('approvalSubmit', $event)"
      @user-input-submit="emit('userInputSubmit', $event)"
      @user-input-cancel="emit('userInputCancel')"
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
        :approval-queue="approvalQueue"
        :approval-submitting-id="approvalSubmittingId"
        :pending-user-input="pendingUserInput"
        :interaction-response-allowed="interactionResponseAllowed"
        :context-usage="contextUsage"
        :session-id="sessionId"
        :message-key="messageKey"
        :active-tab="activeTab"
        :task-state="taskState"
        :goal-state="goalState"
        @update:active-tab="emit('update:activeTab', $event)"
        @approval-submit="emit('approvalSubmit', $event)"
        @user-input-submit="emit('userInputSubmit', $event)"
        @user-input-cancel="emit('userInputCancel')"
        @file-select="emit('fileSelect', $event)"
        @file-changes="emit('fileChanges')"
        @select-execution-message="emit('selectExecutionMessage', $event)"
      />
    </SheetContent>
  </Sheet>

  <ApprovalDialog ref="approvalDialogRef" />
  <UserInputDialog ref="userInputDialogRef" />
</template>

<script setup>
import { ref } from 'vue';
import ApprovalDialog from '../ApprovalDialog.vue';
import UserInputDialog from '../UserInputDialog.vue';
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
  approvalQueue: { type: Array, default: () => [] },
  approvalSubmittingId: { type: String, default: '' },
  pendingUserInput: { type: Object, default: null },
  interactionResponseAllowed: { type: Boolean, default: false },
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
  'approvalSubmit',
  'userInputSubmit',
  'userInputCancel',
  'fileSelect',
  'fileChanges',
  'selectExecutionMessage',
]);

const approvalDialogRef = ref(null);
const userInputDialogRef = ref(null);

const showApproval = (...args) => approvalDialogRef.value?.show?.(...args);
const hideApproval = () => approvalDialogRef.value?.hide?.();
const toggleApprovalCollapsed = () => approvalDialogRef.value?.toggleCollapsed?.();

const showUserInput = (...args) => userInputDialogRef.value?.show?.(...args);
const hideUserInput = () => userInputDialogRef.value?.hide?.();
const toggleUserInputCollapsed = () => userInputDialogRef.value?.toggleCollapsed?.();

defineExpose({
  show: showApproval,
  hide: hideApproval,
  showApproval,
  hideApproval,
  toggleApprovalCollapsed,
  showUserInput,
  hideUserInput,
  toggleUserInputCollapsed,
});
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
