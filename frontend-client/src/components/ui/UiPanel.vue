<template>
  <component :is="as" class="ui-panel" :class="panelClasses">
    <slot />
  </component>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  as: { type: [String, Object], default: 'section' },
  tone: { type: String, default: 'default' },
  padding: { type: String, default: 'md' },
  interactive: { type: Boolean, default: false },
});

const panelClasses = computed(() => [
  `ui-panel--${props.tone}`,
  `ui-panel--padding-${props.padding}`,
  { 'ui-panel--interactive': props.interactive },
]);
</script>

<style scoped>
.ui-panel {
  min-width: 0;
  border: none;
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
  color: var(--color-text-primary);
}

.ui-panel--shell {
  background: var(--surface-shell);
}

.ui-panel--muted {
  background: var(--color-bg-secondary);
}

.ui-panel--padding-none {
  padding: 0;
}

.ui-panel--padding-sm {
  padding: var(--spacing-sm);
}

.ui-panel--padding-md {
  padding: var(--spacing-md);
}

.ui-panel--padding-lg {
  padding: var(--spacing-lg);
}

.ui-panel--interactive {
  text-decoration: none;
  transition: box-shadow var(--transition-normal);
}

.ui-panel--interactive:hover {
  box-shadow: var(--shadow-elevated);
}

.ui-panel--interactive:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
</style>
