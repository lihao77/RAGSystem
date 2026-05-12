<template>
  <component :is="as" class="ui-badge" :class="badgeClasses">
    <slot />
  </component>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  as: { type: [String, Object], default: 'span' },
  tone: { type: String, default: 'neutral' },
  size: { type: String, default: 'md' },
  pill: { type: Boolean, default: true },
});

const badgeClasses = computed(() => [
  `ui-badge--${props.tone}`,
  `ui-badge--${props.size}`,
  { 'ui-badge--pill': props.pill },
]);
</script>

<style scoped>
.ui-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--surface-panel-muted);
  color: var(--color-text-secondary);
  font-weight: 650;
  line-height: 1.2;
  white-space: nowrap;
}

.ui-badge--pill {
  border-radius: var(--radius-full);
}

.ui-badge--sm {
  min-height: 22px;
  padding: 2px 7px;
  font-size: var(--font-size-xs);
}

.ui-badge--md {
  min-height: 28px;
  padding: 3px 9px;
  font-size: var(--font-size-xs);
}

.ui-badge--success {
  border-color: rgba(var(--color-success-rgb), 0.28);
  background: rgba(var(--color-success-rgb), 0.1);
  color: var(--color-success);
}

.ui-badge--warning {
  border-color: rgba(var(--color-warning-rgb), 0.28);
  background: rgba(var(--color-warning-rgb), 0.1);
  color: var(--color-warning);
}

.ui-badge--error {
  border-color: rgba(var(--color-error-rgb), 0.28);
  background: rgba(var(--color-error-rgb), 0.1);
  color: var(--color-error);
}

.ui-badge--info {
  border-color: rgba(var(--color-brand-accent-rgb), 0.28);
  background: rgba(var(--color-brand-accent-rgb), 0.1);
  color: var(--color-brand-accent);
}
</style>
