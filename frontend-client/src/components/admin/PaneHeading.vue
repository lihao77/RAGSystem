<template>
  <div class="wb-pane-heading">
    <div class="wb-pane-heading__text">
      <h3>{{ title }}</h3>
      <p v-if="subtitle">{{ subtitle }}</p>
    </div>
    <div v-if="$slots.actions" class="wb-pane-heading__actions">
      <slot name="actions" />
    </div>
  </div>
</template>

<script setup>
// 面板小节标题（左文右操作）：样式见 styles/admin-workbench.css（.wb-pane-heading）
defineProps({
  title: { type: String, required: true },
  subtitle: { type: String, default: '' },
});
</script>
