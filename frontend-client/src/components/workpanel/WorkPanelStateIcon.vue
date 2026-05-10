<template>
  <svg class="wpsi-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <template v-if="kind === 'input'">
      <path d="M5 5h14v11H9l-4 4V5Z" />
      <path d="M8 9h8" />
      <path d="M8 13h5" />
    </template>

    <template v-else-if="kind === 'approval'">
      <path d="M12 3l7 3v5c0 4.2-2.7 7.7-7 10-4.3-2.3-7-5.8-7-10V6l7-3Z" />
      <path d="M9 12l2 2 4-5" />
    </template>

    <template v-else-if="kind === 'error'">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v6" />
      <path d="M12 17h.01" />
    </template>

    <template v-else-if="kind === 'success'">
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12l3 3 5-6" />
    </template>

    <template v-else-if="kind === 'running'">
      <circle cx="12" cy="12" r="9" />
      <path class="wpsi-filled" d="M10 8.5v7l5.5-3.5L10 8.5Z" />
    </template>

    <template v-else>
      <path d="M5 7h14" />
      <path d="M5 12h14" />
      <path d="M5 17h9" />
    </template>
  </svg>
</template>

<script setup>
defineProps({
  kind: { type: String, default: 'idle' },
})
</script>

<style scoped>
.wpsi-icon {
  display: block;
  width: 1em;
  height: 1em;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.8;
  stroke-linecap: round;
  stroke-linejoin: round;
}

.wpsi-filled {
  fill: currentColor;
  stroke: none;
}
</style>
