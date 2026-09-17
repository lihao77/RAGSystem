<template>
  <Transition enter-active-class="transition-opacity duration-150" enter-from-class="opacity-0" leave-active-class="transition-opacity duration-150" leave-to-class="opacity-0">
    <span v-if="change" class="skill-file-change inline-flex size-3 shrink-0 items-center justify-center" :data-change="change" :title="label" role="img" :aria-label="label">
      <Plus v-if="change === 'added'" class="size-3 text-success" aria-hidden="true" />
      <StatusDot v-else tone="warning" size="sm" />
    </span>
  </Transition>
</template>

<script setup>
import { computed } from 'vue';
import { Plus } from 'lucide-vue-next';
import StatusDot from '../admin/StatusDot.vue';

const props = defineProps({ change: { type: String, default: '' }, directory: { type: Boolean, default: false } });
const label = computed(() => props.directory ? '包含未保存的更改' : props.change === 'added' ? '新增文件，未保存' : '已修改，未保存');
</script>
