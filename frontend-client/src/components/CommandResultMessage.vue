<template>
  <div :class="['command-result', statusClass]">
    <span class="command-name">{{ commandName }}</span>
    <span class="command-status">{{ statusIcon }}</span>
    <span class="command-text">{{ message.content }}</span>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  message: { type: Object, required: true },
});

const commandName = computed(() => {
  const meta = props.message.metadata || {};
  return `/${meta.command || 'unknown'}`;
});

const statusIcon = computed(() => {
  const meta = props.message.metadata || {};
  if (meta.error) return '\u2718';
  if (meta.success === false) return '\u2718';
  if (meta.command === 'unknown') return '?';
  return '\u2713';
});

const statusClass = computed(() => {
  const meta = props.message.metadata || {};
  if (meta.error || meta.success === false || meta.command === 'unknown') return 'error';
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
  background: rgba(239, 68, 68, 0.06);
  border: 1px solid rgba(var(--color-error-rgb), 0.18);
}

.command-name {
  font-family: var(--font-mono, monospace);
  font-weight: 600;
  color: var(--color-brand-accent-light, var(--color-interactive, #6366f1));
  flex-shrink: 0;
}

.command-status {
  flex-shrink: 0;
}

.success .command-status {
  color: #22c55e;
}

.error .command-status {
  color: #ef4444;
}

.command-text {
  color: var(--color-text-secondary, #666);
}
</style>
