<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" :fill="color" xmlns="http://www.w3.org/2000/svg" class="icon-stop">
    <rect x="6" y="6" width="12" height="12" rx="2" />
  </svg>
</template>
<script setup>
defineProps({
  size: { type: [Number, String], default: 18 },
  color: { type: String, default: 'currentColor' },
});
</script>
<style scoped>
.icon-stop { flex-shrink: 0; transition: all var(--transition-normal); }
</style>
