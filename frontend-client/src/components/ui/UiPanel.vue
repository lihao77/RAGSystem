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
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  background: var(--surface-panel);
  color: var(--color-text-primary);
}

.ui-panel--shell {
  background: var(--surface-shell);
}

.ui-panel--muted {
  background: var(--surface-panel-muted);
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
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    transform var(--transition-fast);
}

.ui-panel--interactive:hover {
  border-color: var(--color-border-hover);
  background: var(--surface-panel-muted);
  transform: translateY(-1px);
}

.ui-panel--interactive:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}
</style>
