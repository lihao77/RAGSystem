<template>
  <ToggleGroup
    type="single"
    size="sm"
    :model-value="modelValue"
    class="session-browser-toggle"
    aria-label="会话浏览视图"
    @update:model-value="selectView"
  >
    <ToggleGroupItem value="project" class="session-browser-toggle-item" aria-label="项目视图">
      <FolderKanban />
      <span>项目</span>
    </ToggleGroupItem>
    <ToggleGroupItem value="timeline" class="session-browser-toggle-item" aria-label="时间轴视图">
      <Clock3 />
      <span>时间轴</span>
    </ToggleGroupItem>
  </ToggleGroup>
</template>

<script setup>
import { Clock3, FolderKanban } from 'lucide-vue-next';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

defineProps({ modelValue: { type: String, required: true } });
const emit = defineEmits(['update:modelValue']);
function selectView(value) {
  if (value) emit('update:modelValue', value);
}
</script>

<style scoped>
.session-browser-toggle {
  width: max-content;
  max-width: 100%;
  height: 30px !important;
  gap: 0;
  padding: 2px !important;
  overflow: hidden;
  border: 0 !important;
  border-radius: var(--radius-full) !important;
  background-color: color-mix(in srgb, var(--color-bg-tertiary) 48%, var(--surface-sidebar)) !important;
  box-shadow: none !important;
}
.session-browser-toggle :deep(.session-browser-toggle-item) {
  min-width: 0;
  height: 26px !important;
  flex: 0 0 auto;
  gap: 5px;
  padding: 0 8px;
  border: 0 !important;
  border-radius: var(--radius-full) !important;
  background-color: transparent !important;
  background-image: none !important;
  color: color-mix(in srgb, var(--color-text-muted) 62%, transparent) !important;
  font-size: 11px !important;
  font-weight: 500;
  box-shadow: none !important;
}
.session-browser-toggle :deep(.session-browser-toggle-item:hover) {
  background-color: color-mix(in srgb, var(--color-bg-primary) 28%, transparent) !important;
  color: var(--color-text-secondary) !important;
}
.session-browser-toggle :deep(.session-browser-toggle-item[data-state='on']) {
  border-radius: var(--radius-full) !important;
  background-color: color-mix(in srgb, var(--color-bg-primary) 82%, var(--color-bg-secondary)) !important;
  background-image: none !important;
  color: var(--color-text-primary) !important;
  box-shadow: none !important;
}
.session-browser-toggle :deep(.session-browser-toggle-item svg) {
  width: 13px;
  height: 13px;
  color: currentColor;
}
</style>
