<template>
  <button
    type="button"
    class="adm-toggle"
    :class="[`adm-toggle--${size}`, { 'adm-toggle--on': modelValue }]"
    role="switch"
    :aria-checked="modelValue ? 'true' : 'false'"
    :disabled="disabled"
    @click="onClick"
  >
    <span class="adm-toggle__thumb" />
  </button>
</template>

<script setup>
/**
 * 管理端开关。收敛各页 toggle-track / toggle-btn / fc-toggle 等多份开关实现,
 * 统一采用 button + role="switch" + aria-checked 的无障碍范式(取自 DaemonManager)。
 * 样式消费全局 .adm-toggle-*(admin-console.css)。
 *
 * 用法: <ToggleSwitch v-model="form.enabled" size="sm" />
 */
const props = defineProps({
  modelValue: { type: Boolean, default: false },
  size: { type: String, default: 'md' }, // 'md' | 'sm'
  disabled: { type: Boolean, default: false },
});
const emit = defineEmits(['update:modelValue']);
function onClick() {
  if (props.disabled) return;
  emit('update:modelValue', !props.modelValue);
}
</script>
