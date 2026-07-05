<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" :fill="color" xmlns="http://www.w3.org/2000/svg" class="icon-play">
    <polygon points="5 3 19 12 5 21 5 3" />
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
.icon-play { flex-shrink: 0; transition: all var(--transition-normal); }
</style>
