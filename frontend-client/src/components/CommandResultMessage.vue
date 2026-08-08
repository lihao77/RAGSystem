<template>
  <div :class="['command-result', statusClass]">
    <span class="command-name">{{ commandName }}</span>
    <span class="command-status"><IconCheck v-if="statusClass === 'success'" :size="13" /><IconClose v-else :size="13" /></span>
    <span class="command-text">{{ result.text }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import IconCheck from './icons/IconCheck.vue';
import IconClose from './icons/IconClose.vue';

const props = defineProps({
  result: { type: Object, required: true },
});

const commandName = computed(() => {
  return `/${props.result.name || 'unknown'}`;
});

const statusClass = computed(() => {
  if (props.result.error || props.result.success === false || props.result.name === 'unknown') return 'error';
  return 'success';
});
</script>

<style scoped>
.command-result {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  margin: 0.4rem 0;
  border-radius: var(--radius-md, 8px);
  font-size: var(--font-size-sm, 13px);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}

.command-result.success {
  background: var(--color-bg-secondary, #f5f5f5);
  border: 1px solid var(--color-border, #e0e0e0);
}

.command-result.error {
  background: rgba(var(--color-error-rgb), 0.06);
  border: 1px solid rgba(var(--color-error-rgb), 0.18);
}

.command-name {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  color: var(--color-brand-accent-light);
  flex-shrink: 0;
}

.command-status {
  flex-shrink: 0;
}

.success .command-status {
  color: var(--color-success);
}

.error .command-status {
  color: var(--color-error);
}

.command-text {
  color: var(--color-text-secondary);
}
</style>
