<template>
  <UiButton
    v-bind="$attrs"
    class="ui-icon-button"
    :as="as"
    :type="type"
    :variant="variant"
    size="icon"
    :disabled="disabled"
    :aria-label="label"
    :title="title || label"
  >
    <template #icon>
      <slot />
    </template>
  </UiButton>
</template>

<script setup>
import UiButton from './UiButton.vue';

defineOptions({ inheritAttrs: false });

defineProps({
  as: { type: [String, Object], default: 'button' },
  type: { type: String, default: 'button' },
  variant: { type: String, default: 'neutral' },
  disabled: { type: Boolean, default: false },
  label: { type: String, required: true },
  title: { type: String, default: '' },
});
</script>
