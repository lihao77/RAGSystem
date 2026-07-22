<template>
  <div
    class="empty-state"
    :class="{ 'empty-state--compact': compact, 'empty-state--error': tone === 'error', 'empty-state--row': row }"
  >
    <span v-if="row" class="empty-state__mark" aria-hidden="true"></span>
    <slot v-else name="icon">
      <component :is="icon" v-if="icon" :size="iconSize" class="empty-state__icon" aria-hidden="true" />
    </slot>
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
  // 图标尺寸,传给 icon 组件的 size prop
  iconSize: { type: [Number, String], default: 40 },
  title: { type: String, required: true },
  hint: { type: String, default: '' },
  // 紧凑模式：更低 min-height 与内边距，适合窄面板/列表内
  compact: { type: Boolean, default: false },
  // 横排模式：左侧装饰圆点 + 单行文字 + 细边框面板,适合执行流/时间线内嵌
  row: { type: Boolean, default: false },
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

.empty-state__icon,
.empty-state :deep(svg) {
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

/* 横排模式:左侧圆点 + 单行,细边框面板 */
.empty-state--row {
  flex-direction: row;
  justify-content: flex-start;
  gap: 8px;
  min-height: 0;
  padding: 14px 12px;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  text-align: left;
  border: 1px solid color-mix(in srgb, var(--color-border) 52%, transparent);
  border-radius: var(--radius-sm);
  background:
    linear-gradient(135deg, rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.28), rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.12));
}

.empty-state--row .empty-state__title {
  color: var(--color-text-muted);
  font-weight: 400;
}

.empty-state__mark {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--color-border);
  flex-shrink: 0;
}
</style>
