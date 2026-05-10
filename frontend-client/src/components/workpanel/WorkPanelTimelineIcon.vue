<template>
  <svg class="wpti-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    <template v-if="kind === 'agent'">
      <path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z" />
      <path d="M4.5 20a7.5 7.5 0 0 1 15 0" />
    </template>

    <template v-else-if="kind === 'thought'">
      <path d="M9 18h6" />
      <path d="M10 22h4" />
      <path d="M8.5 14.5a6 6 0 1 1 7 0c-.9.6-1.5 1.6-1.5 2.5h-4c0-.9-.6-1.9-1.5-2.5Z" />
    </template>

    <template v-else-if="kind === 'tool'">
      <path d="M14.7 6.3a4 4 0 0 0-5 5L4 17l3 3 5.7-5.7a4 4 0 0 0 5-5l-2.9 2.9-3-3 2.9-2.9Z" />
    </template>

    <template v-else-if="kind === 'code'">
      <path d="M4 5h16v14H4z" />
      <path d="m8 9 3 3-3 3" />
      <path d="M13 15h3" />
    </template>

    <template v-else-if="kind === 'file'">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </template>

    <template v-else-if="kind === 'search'">
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </template>

    <template v-else-if="kind === 'globe'">
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18" />
      <path d="M12 3a14 14 0 0 1 0 18" />
      <path d="M12 3a14 14 0 0 0 0 18" />
    </template>

    <template v-else-if="kind === 'map'">
      <path d="m9 18-6 3V6l6-3 6 3 6-3v15l-6 3-6-3Z" />
      <path d="M9 3v15" />
      <path d="M15 6v15" />
    </template>

    <template v-else-if="kind === 'chart'">
      <path d="M4 19V5" />
      <path d="M4 19h16" />
      <rect x="7" y="11" width="3" height="5" rx="1" />
      <rect x="12" y="8" width="3" height="8" rx="1" />
      <rect x="17" y="5" width="3" height="11" rx="1" />
    </template>

    <template v-else-if="kind === 'skill'">
      <path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6L12 3Z" />
      <path d="M5 14l.8 2.2L8 17l-2.2.8L5 20l-.8-2.2L2 17l2.2-.8L5 14Z" />
      <path d="M19 14l.6 1.6L21 16l-1.4.4L19 18l-.6-1.6L17 16l1.4-.4L19 14Z" />
    </template>

    <template v-else-if="kind === 'input'">
      <path d="M4 5h16v12H7l-3 3V5Z" />
      <path d="M8 10h8" />
      <path d="M8 14h5" />
    </template>

    <template v-else-if="kind === 'database'">
      <ellipse cx="12" cy="5" rx="7" ry="3" />
      <path d="M5 5v6c0 1.7 3.1 3 7 3s7-1.3 7-3V5" />
      <path d="M5 11v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
    </template>

    <template v-else-if="kind === 'task'">
      <path d="M5 6h14" />
      <path d="M5 12h14" />
      <path d="M5 18h8" />
      <path d="m15 18 2 2 4-4" />
    </template>

    <template v-else-if="kind === 'agentCall'">
      <circle cx="7" cy="12" r="3" />
      <circle cx="17" cy="6" r="3" />
      <circle cx="17" cy="18" r="3" />
      <path d="M10 11l4-3" />
      <path d="M10 13l4 3" />
    </template>

    <template v-else>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 8v4l3 2" />
    </template>
  </svg>
</template>

<script setup>
defineProps({
  kind: { type: String, default: 'step' },
})
</script>

<style scoped>
.wpti-icon {
  display: block;
  width: 1em;
  height: 1em;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.9;
  stroke-linecap: round;
  stroke-linejoin: round;
}
</style>
