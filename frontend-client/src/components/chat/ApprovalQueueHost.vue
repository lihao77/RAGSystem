<template>
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
  />

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
});

const emit = defineEmits(['approvalSubmit', 'userInputSubmit', 'userInputCancel']);

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
