<template>
  <div class="ui-tabs" role="tablist">
    <button
      v-for="tab in tabs"
      :key="tab.key"
      type="button"
      class="ui-tab"
      :class="{ active: tab.key === modelValue }"
      role="tab"
      :aria-selected="tab.key === modelValue"
      @click="$emit('update:modelValue', tab.key)"
    >
      {{ tab.label }}
    </button>
  </div>
</template>

<script setup>
defineProps({
  tabs: { type: Array, required: true },
  modelValue: { type: [String, Number], default: '' },
});

defineEmits(['update:modelValue']);
</script>

<style scoped>
.ui-tabs {
  display: inline-flex;
  gap: 2px;
  padding: var(--spacing-xs);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-lg);
}

.ui-tab {
  padding: var(--spacing-xs) var(--spacing-md);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 500;
  border-radius: var(--control-radius);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.ui-tab:hover {
  color: var(--color-text-primary);
}

.ui-tab.active {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-sm);
}
</style>
