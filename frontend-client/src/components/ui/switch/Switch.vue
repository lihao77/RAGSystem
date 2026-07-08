<script setup lang="ts">
import type { HTMLAttributes } from 'vue'
import { SwitchRoot, SwitchThumb } from 'reka-ui'
import { cn } from '@/lib/utils'

const props = defineProps<{
  checked?: boolean
  defaultChecked?: boolean
  disabled?: boolean
  required?: boolean
  name?: string
  value?: string
  class?: HTMLAttributes['class']
}>()
const emits = defineEmits<{ (e: 'update:checked', payload: boolean): void }>()
</script>

<template>
  <SwitchRoot
    :model-value="checked"
    :default-value="defaultChecked"
    :disabled="disabled"
    :required="required"
    :name="name"
    :value="value"
    @update:model-value="emits('update:checked', $event)"
    :class="cn(
      'peer inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:bg-brand-accent data-[state=unchecked]:bg-muted',
      props.class,
    )"
  >
    <SwitchThumb class="pointer-events-none block h-5 w-5 rounded-full bg-foreground shadow-lg ring-0 transition-transform data-[state=checked]:translate-x-5 data-[state=unchecked]:translate-x-0" />
  </SwitchRoot>
</template>
