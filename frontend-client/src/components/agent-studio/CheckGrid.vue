<template>
  <p v-if="!items.length" class="panel-empty">{{ emptyText }}</p>
  <div v-else class="check-list">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      :class="['check-row', { 'check-row--on': selected.includes(item.key) }]"
      :aria-pressed="selected.includes(item.key)"
      @click="$emit('toggle', item.key)"
    >
      <span class="check-row__icon" aria-hidden="true">
        <component :is="iconComponent" :size="16" />
      </span>
      <span class="check-row__copy">
        <span class="check-row__name">{{ item.label }}</span>
        <span v-if="item.title && item.title !== item.label" class="check-row__desc">{{ item.title }}</span>
      </span>
      <span class="check-row__tick" aria-hidden="true">
        <Check :size="12" />
      </span>
    </button>
  </div>
</template>

<script setup>
// 卡片行多选：图标 + 名称 + 描述 + 右侧圆形勾选，替代原胶囊 chip。
import { computed } from 'vue';
import { Box, Check, Plug, Users, Wrench, Zap } from 'lucide-vue-next';

const props = defineProps({
  items: { type: Array, default: () => [] }, // [{ key, label, title? }]
  selected: { type: Array, default: () => [] },
  emptyText: { type: String, default: '暂无可选项。' },
  icon: { type: String, default: 'Box' }, // lucide 组件名：Wrench/Users/Zap/Plug/Box
});
defineEmits(['toggle']);

const iconMap = { Box, Wrench, Users, Zap, Plug };
const iconComponent = computed(() => iconMap[props.icon] || Box);
</script>

<style>
/* 非 scoped：限定 .studio-panel，避免各面板复制样式；遵循 admin-workbench 的 token 规约 */
.studio-panel .check-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.studio-panel .check-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-width: 0;
  min-height: 48px;
  padding: 8px 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}
.studio-panel .check-row:hover {
  background: var(--color-hover-overlay-md);
}
.studio-panel .check-row--on {
  background: var(--color-active-bg);
  border-color: transparent;
}
.studio-panel .check-row--on:hover {
  background: var(--color-active-bg);
}
.studio-panel .check-row__icon {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  background: var(--color-bg-tertiary);
  color: var(--color-text-muted);
  transition: color var(--transition-fast);
}
.studio-panel .check-row--on .check-row__icon {
  color: var(--color-brand-accent);
}
.studio-panel .check-row__copy {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.studio-panel .check-row__name {
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio-panel .check-row--on .check-row__name {
  color: var(--color-brand-accent);
}
.studio-panel .check-row__desc {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  line-height: 1.4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.studio-panel .check-row__tick {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  color: transparent;
  transition: background var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}
.studio-panel .check-row--on .check-row__tick {
  background: var(--color-brand-accent);
  border-color: var(--color-brand-accent);
  color: var(--color-accent-fg);
}
</style>
