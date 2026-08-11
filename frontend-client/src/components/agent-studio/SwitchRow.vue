<template>
  <div class="switch-row">
    <div class="switch-row__copy">
      <span class="switch-row__label">{{ label }}</span>
      <span v-if="hint" class="switch-row__hint">{{ hint }}</span>
    </div>
    <Switch :checked="checked" :disabled="disabled" @update:checked="$emit('update:checked', $event)" />
  </div>
</template>

<script setup>
import { Switch } from '../ui/switch';

defineProps({
  label: { type: String, required: true },
  hint: { type: String, default: '' },
  checked: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
});
defineEmits(['update:checked']);
</script>
