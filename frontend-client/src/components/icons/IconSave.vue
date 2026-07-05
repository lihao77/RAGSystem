<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" class="icon-save">
    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" :stroke="color" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" />
    <polyline points="17 21 17 13 7 13 7 21" :stroke="color" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" />
    <polyline points="7 3 7 8 15 8" :stroke="color" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" />
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
.icon-save { flex-shrink: 0; transition: all var(--transition-normal); }
</style>
