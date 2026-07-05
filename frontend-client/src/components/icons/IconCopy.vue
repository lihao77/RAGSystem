<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-copy">
    <rect width="14" height="14" x="8" y="8" rx="2" ry="2" :stroke="color" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" :stroke="color" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" />
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
.icon-copy { flex-shrink: 0; transition: all var(--transition-normal); }
</style>
