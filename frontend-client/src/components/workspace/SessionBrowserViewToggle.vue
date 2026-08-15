<template>
  <SegmentedControl :model-value="modelValue" :options="viewOptions" aria-label="会话浏览视图" @update:model-value="(v) => emit('update:modelValue', v)" />
</template>

<script setup>
import { Clock3, FolderKanban } from 'lucide-vue-next';
import SegmentedControl from '@/components/SegmentedControl.vue';

defineProps({ modelValue: { type: String, required: true } });
const emit = defineEmits(['update:modelValue']);

const viewOptions = [
  { value: 'project', label: '项目', icon: FolderKanban, ariaLabel: '项目视图' },
  { value: 'timeline', label: '时间轴', icon: Clock3, ariaLabel: '时间轴视图' },
];
</script>
