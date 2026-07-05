<template>
  <svg :width="size" :height="size" viewBox="0 0 24 24" :fill="color" xmlns="http://www.w3.org/2000/svg" class="icon-send">
    <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
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
.icon-send { flex-shrink: 0; transition: all var(--transition-normal); }
</style>
