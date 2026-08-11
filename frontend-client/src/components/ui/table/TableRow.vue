<script setup lang="ts">
import type { HTMLAttributes } from "vue"
import { cn } from "@/lib/utils"

const props = defineProps<{
  class?: HTMLAttributes["class"]
}>()
</script>

<template>
  <tr :class="cn('border-b border-border/60 transition-colors hover:bg-hover-overlay data-[state=selected]:bg-active-bg', props.class)">
    <slot />
  </tr>
</template>
