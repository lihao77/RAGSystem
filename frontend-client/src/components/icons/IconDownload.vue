<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-download">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" :stroke="color" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" />
    <polyline points="7 10 12 15 17 10" :stroke="color" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" />
    <line x1="12" y1="15" x2="12" y2="3" :stroke="color" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" />
  </svg>
</template>
<script setup>
defineProps({
  size: { type: [Number, String], default: 18 },
  color: { type: String, default: 'currentColor' },
  strokeWidth: { type: [Number, String], default: 2 },
});
</script>
<style scoped>
.icon-download { flex-shrink: 0; transition: all var(--transition-normal); }
</style>
