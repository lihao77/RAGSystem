<template>
  <div v-if="entries.length" class="ui-context-card">
    <span class="uc-icon" aria-hidden="true">🧩</span>
    <div class="uc-entries">
      <div v-for="e in entries" :key="e.key" class="uc-entry">
        <span class="uc-label">{{ e.label }}</span>
        <span class="uc-value">{{ e.value }}<span v-if="e.detail" class="uc-detail"> · {{ e.detail }}</span></span>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  // ui_context extension 的 data:{ captured_at, entries:[{key,label,value,detail?}] }
  data: { type: Object, default: () => ({}) },
  msg: { type: Object, default: null },
});

const entries = computed(() => {
  const arr = Array.isArray(props.data?.entries) ? props.data.entries : [];
  return arr.filter((e) => e && typeof e === 'object' && typeof e.value === 'string');
});
</script>

<style scoped>
.ui-context-card {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.4rem 0.6rem;
  margin: 0 0 0.4rem;
  border-radius: var(--radius-md, 8px);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  font-size: var(--font-size-sm, 13px);
  line-height: 1.5;
}

.uc-icon {
  flex-shrink: 0;
  line-height: 1.5;
}

.uc-entries {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  min-width: 0;
}

.uc-entry {
  display: flex;
  gap: 0.4rem;
  align-items: baseline;
  min-width: 0;
}

.uc-label {
  color: var(--color-text-muted);
  flex-shrink: 0;
}

.uc-value {
  color: var(--color-text-secondary);
  word-break: break-word;
}

.uc-detail {
  color: var(--color-text-muted);
}
</style>
