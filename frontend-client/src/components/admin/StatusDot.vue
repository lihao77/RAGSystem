<template>
  <span
    class="status-dot"
    :class="[`status-dot--${tone}`, { 'status-dot--sm': size === 'sm', 'status-dot--pulse': pulse }]"
    :title="label || null"
    aria-hidden="true"
  />
</template>

<script setup>
// 统一状态点：替代各页自造 .status-dot（样式见 styles/admin-workbench.css）
defineProps({
  tone: {
    type: String,
    default: 'muted',
    validator: (v) => ['success', 'warning', 'error', 'active', 'muted'].includes(v),
  },
  size: {
    type: String,
    default: 'md',
    validator: (v) => ['sm', 'md'].includes(v),
  },
  pulse: { type: Boolean, default: false },
  label: { type: String, default: '' },
});
</script>
