<template>
  <section
    class="chat-interaction-host"
    aria-label="待处理交互"
    aria-live="polite"
  >
    <WorkPanelUserInput
      v-if="pendingUserInput"
      :input-data="pendingUserInput.data"
      :response-allowed="responseAllowed"
      @submit="emit('user-input-submit', $event)"
      @cancel="emit('user-input-cancel')"
    />
    <WorkPanelApproval
      v-if="approvalQueue.length"
      :queue="approvalQueue"
      :submitting-id="approvalSubmittingId"
      :response-allowed="responseAllowed"
      @submit="emit('approval-submit', $event)"
    />
  </section>
</template>

<script setup>
import WorkPanelApproval from '../workpanel/WorkPanelApproval.vue';
import WorkPanelUserInput from '../workpanel/WorkPanelUserInput.vue';

defineProps({
  approvalQueue: { type: Array, default: () => [] },
  approvalSubmittingId: { type: String, default: '' },
  pendingUserInput: { type: Object, default: null },
  responseAllowed: { type: Boolean, default: false },
});

const emit = defineEmits(['approval-submit', 'user-input-submit', 'user-input-cancel']);
</script>

<style scoped>
.chat-interaction-host {
  flex: 0 0 auto;
  width: 100%;
  max-width: calc(var(--content-max-width) + 2 * var(--chat-padding-x));
  min-width: 0;
  margin: 0 auto;
  padding: 0 var(--chat-padding-x) var(--spacing-sm);
  box-sizing: border-box;
}

.chat-interaction-host :deep(.wpa-root),
.chat-interaction-host :deep(.wpui-root) {
  padding-inline: 0;
}

.chat-interaction-host :deep(.wpui-root) {
  border-top: 0;
}

</style>
