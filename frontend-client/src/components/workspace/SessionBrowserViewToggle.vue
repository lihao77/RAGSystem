<template>
  <ToggleGroup
    type="single"
    variant="segment"
    size="segment"
    :model-value="modelValue"
    class="segmented-track"
    aria-label="会话浏览视图"
    @update:model-value="selectView"
  >
    <ToggleGroupItem value="project" aria-label="项目视图">
      <FolderKanban />
      <span>项目</span>
    </ToggleGroupItem>
    <ToggleGroupItem value="timeline" aria-label="时间轴视图">
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
/* 胶囊分段控件轨道:项样式由 toggle 的 segment variant 承载,这里只管轨道。 */
.segmented-track {
  width: max-content;
  max-width: 100%;
  gap: 0;
  padding: 2px;
  overflow: hidden;
  border-radius: var(--radius-full);
  background-color: var(--color-hover-overlay-md);
}
</style>
