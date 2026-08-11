<template>
  <p v-if="!items.length" class="panel-empty">{{ emptyText }}</p>
  <div v-else class="chip-grid">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      :class="['chip', { 'chip--on': selected.includes(item.key) }]"
      :title="item.title || item.label"
      :aria-pressed="selected.includes(item.key)"
      @click="$emit('toggle', item.key)"
    >
      <svg v-if="selected.includes(item.key)" class="chip__check" viewBox="0 0 12 12" fill="none" aria-hidden="true">
        <path d="M2.5 6.2 5 8.5 9.5 3.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span class="chip__text">{{ item.label }}</span>
    </button>
  </div>
</template>

<script setup>
defineProps({
  items: { type: Array, default: () => [] }, // [{ key, label, title? }]
  selected: { type: Array, default: () => [] },
  emptyText: { type: String, default: '暂无可选项。' },
});
defineEmits(['toggle']);
</script>

<style>
/* 胶囊多选（非 scoped，限定 .studio-panel）：选中=accent 淡底+勾+描边，未选=发丝描边灰字 */
.studio-panel .chip-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.studio-panel .chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 5px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--color-text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}
.studio-panel .chip:hover {
  border-color: var(--color-border-hover);
  color: var(--color-text-primary);
  background: var(--color-hover-overlay-md);
}
.studio-panel .chip--on {
  background: var(--color-active-bg);
  border-color: rgba(var(--color-brand-accent-rgb), 0.5);
  color: var(--color-brand-accent);
  font-weight: 500;
}
.studio-panel .chip--on:hover {
  background: var(--color-active-bg);
  border-color: var(--color-brand-accent);
  color: var(--color-brand-accent);
}
.studio-panel .chip__check {
  width: 11px;
  height: 11px;
  flex-shrink: 0;
}
.studio-panel .chip__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>
