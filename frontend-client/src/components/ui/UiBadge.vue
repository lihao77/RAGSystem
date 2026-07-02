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
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-hover-overlay-md);
  color: var(--color-text-secondary);
  font-weight: 600;
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
  background: var(--color-success-bg);
  color: var(--color-success);
}

.ui-badge--warning {
  background: var(--color-warning-bg);
  color: var(--color-warning);
}

.ui-badge--error {
  background: var(--color-error-bg);
  color: var(--color-error);
}

.ui-badge--info {
  background: var(--color-active-bg);
  color: var(--color-brand-accent);
}
</style>
