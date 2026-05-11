<template>
  <Transition
    :name="disableTransition ? '' : 'work-panel-shell'"
    :css="!disableTransition"
  >
    <WorkPanel
      v-if="showWorkPanel"
      :active-run="activeRun"
      :current-message="currentMessage"
      :approval-queue="approvalQueue"
      :approval-submitting-id="approvalSubmittingId"
      :pending-user-input="pendingUserInput"
      :context-usage="contextUsage"
      :session-id="sessionId"
      :message-key="messageKey"
      @approval-submit="emit('approvalSubmit', $event)"
      @user-input-submit="emit('userInputSubmit', $event)"
      @user-input-cancel="emit('userInputCancel')"
      @artifact-select="emit('artifactSelect', $event)"
    />
  </Transition>

  <ApprovalDialog ref="approvalDialogRef" />
  <UserInputDialog ref="userInputDialogRef" />
</template>

<script setup>
import { ref } from 'vue';
import ApprovalDialog from '../ApprovalDialog.vue';
import UserInputDialog from '../UserInputDialog.vue';
import WorkPanel from '../workpanel/WorkPanel.vue';

defineProps({
  showWorkPanel: { type: Boolean, default: false },
  activeRun: { type: Object, required: true },
  currentMessage: { type: Object, default: null },
  approvalQueue: { type: Array, default: () => [] },
  approvalSubmittingId: { type: String, default: '' },
  pendingUserInput: { type: Object, default: null },
  contextUsage: { type: Object, default: () => ({ used: 0, max: 0 }) },
  sessionId: { type: String, default: '' },
  messageKey: { type: String, default: '' },
  disableTransition: { type: Boolean, default: false },
});

const emit = defineEmits(['approvalSubmit', 'userInputSubmit', 'userInputCancel', 'artifactSelect']);

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
    width 420ms cubic-bezier(0.22, 1, 0.36, 1),
    opacity 300ms ease,
    transform 420ms cubic-bezier(0.22, 1, 0.36, 1);
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
