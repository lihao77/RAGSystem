<template>
  <component
    :is="as"
    class="ui-action-button"
    :class="[`ui-action-button--${variant}`, { 'is-disabled': disabled }]"
    :type="nativeType"
    :disabled="nativeDisabled"
    :aria-disabled="disabled || undefined"
  >
    <span v-if="$slots.icon" class="ui-action-button__icon">
      <slot name="icon" />
    </span>
    <span v-if="$slots.default" class="ui-action-button__content">
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
  disabled: { type: Boolean, default: false },
});

const isNativeButton = computed(() => props.as === 'button');
const nativeType = computed(() => (isNativeButton.value ? props.type : undefined));
const nativeDisabled = computed(() => (isNativeButton.value ? props.disabled : undefined));
</script>

<style scoped>
.ui-action-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 28px;
  padding: 0 10px;
  border: none;
  border-radius: var(--control-radius);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1;
  letter-spacing: 0;
  white-space: nowrap;
  text-decoration: none;
  user-select: none;
  cursor: pointer;
  transition:
    background var(--transition-fast),
    color var(--transition-fast);
}

.ui-action-button:hover:not(.is-disabled) {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

.ui-action-button:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
}

.ui-action-button.is-disabled {
  opacity: 0.4;
  cursor: not-allowed;
  pointer-events: none;
}

.ui-action-button--success:hover:not(.is-disabled) {
  color: var(--color-success);
  background: var(--color-success-bg);
}

.ui-action-button--warning:hover:not(.is-disabled) {
  color: var(--color-warning);
  background: var(--color-warning-bg);
}

.ui-action-button--danger {
  color: var(--color-error);
}

.ui-action-button--danger:hover:not(.is-disabled) {
  background: var(--color-error-bg);
}

.ui-action-button__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
}

.ui-action-button__content {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
