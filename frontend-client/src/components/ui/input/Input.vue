<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { computed } from 'vue'
import { cn } from '@/lib/utils'

const props = defineProps<{
  modelValue?: string | number | null
  class?: HTMLAttributes['class']
}>()
const emits = defineEmits<{ (e: 'update:modelValue', payload: string | number): void }>()
const value = computed({
  get: () => (props.modelValue === null || props.modelValue === undefined) ? '' : props.modelValue,
  set: (v) => emits('update:modelValue', v as string | number),
})
</script>

<template>
  <input v-model="value" :class="cn('form-control', props.class)">
</template>
