<template>
  <component
    :is="as"
    class="ui-button"
    :class="buttonClasses"
    :type="nativeType"
    :disabled="nativeDisabled"
    :aria-disabled="disabled || undefined"
  >
    <span v-if="$slots.icon" class="ui-button__icon">
      <slot name="icon" />
    </span>
    <span v-if="$slots.default" class="ui-button__content">
      <slot />
    </span>
  </component>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  as: { type: [String, Object], default: 'button' },
  type: { type: String, default: 'button' },
  variant: { type: String, default: 'neutral' },
  size: { type: String, default: 'md' },
  block: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
});

const isNativeButton = computed(() => props.as === 'button');
const nativeType = computed(() => (isNativeButton.value ? props.type : undefined));
const nativeDisabled = computed(() => (isNativeButton.value ? props.disabled : undefined));

const buttonClasses = computed(() => [
  `ui-button--${props.variant}`,
  `ui-button--${props.size}`,
  {
    'ui-button--block': props.block,
    'is-disabled': props.disabled,
  },
]);
</script>

<style scoped>
.ui-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  min-width: 0;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-interactive);
  color: var(--color-text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0;
  text-decoration: none;
  white-space: nowrap;
  user-select: none;
  transition:
    background var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast),
    opacity var(--transition-fast);
}

.ui-button:hover:not(.is-disabled) {
  background: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
}

.ui-button:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.ui-button.is-disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.ui-button--sm {
  min-height: var(--control-height-sm);
  padding: 0 10px;
  font-size: var(--font-size-xs);
}

.ui-button--compact {
  min-height: var(--control-height-compact);
  padding: 0 14px;
}

.ui-button--md {
  min-height: var(--control-height-md);
  padding: 0 16px;
}

.ui-button--icon {
  width: var(--icon-button-size-md);
  min-width: var(--icon-button-size-md);
  height: var(--control-height-md);
  padding: 0;
}

.ui-button--primary {
  border-color: var(--color-brand-accent);
  background: var(--color-brand-accent);
  color: var(--color-on-color);
}

.ui-button--primary:hover:not(.is-disabled) {
  border-color: var(--color-brand-accent-light);
  background: var(--color-brand-accent-light);
}

.ui-button--danger {
  border-color: rgba(var(--color-error-rgb), 0.35);
  background: rgba(var(--color-error-rgb), 0.08);
  color: var(--color-error);
}

.ui-button--danger:hover:not(.is-disabled) {
  border-color: rgba(var(--color-error-rgb), 0.55);
  background: rgba(var(--color-error-rgb), 0.16);
}

.ui-button--ghost {
  border-color: transparent;
  background: transparent;
  color: var(--color-text-secondary);
}

.ui-button--ghost:hover:not(.is-disabled) {
  border-color: var(--color-border);
  background: var(--color-hover-overlay);
  color: var(--color-text-primary);
}

.ui-button--block {
  width: 100%;
}

.ui-button__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.ui-button__content {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
