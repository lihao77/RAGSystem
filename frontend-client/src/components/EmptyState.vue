<template>
  <div
    class="empty-state"
    :class="{ 'empty-state--compact': compact, 'empty-state--error': tone === 'error' }"
  >
    <component :is="icon" v-if="icon" class="empty-state__icon" aria-hidden="true" />
    <p class="empty-state__title">{{ title }}</p>
    <p v-if="hint" class="empty-state__hint">{{ hint }}</p>
    <slot />
  </div>
</template>

<script setup>
// 统一空状态：视觉基于全局 .adm-state（flex 居中 + min-height + 次级文字）
defineProps({
  // 可选图标组件（如 lucide 或本地 icons/ 组件）
  icon: { type: [Object, Function], default: null },
  title: { type: String, required: true },
  hint: { type: String, default: '' },
  // 紧凑模式：更低 min-height 与内边距，适合窄面板/列表内
  compact: { type: Boolean, default: false },
  // default | error，error 时标题与整体文字走错误色
  tone: { type: String, default: 'default' },
});
</script>

<style scoped>
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  min-height: 140px;
  padding: var(--spacing-xl);
  color: var(--color-text-secondary);
  text-align: center;
  font-size: var(--font-size-sm);
}

.empty-state--compact {
  min-height: 96px;
  padding: var(--spacing-lg);
}

.empty-state--error {
  color: var(--color-error);
}

.empty-state__icon {
  color: var(--color-text-muted);
}

.empty-state__title {
  margin: 0;
  color: var(--color-text-primary);
  font-weight: 600;
}

.empty-state__hint {
  margin: 0;
  color: var(--color-text-secondary);
}

.empty-state--error .empty-state__title {
  color: var(--color-error);
}
</style>
