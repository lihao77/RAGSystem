<template>
  <div class="renderer-select">
    <button
      v-for="(opt, idx) in options"
      :key="idx"
      class="r-option"
      :class="{ active: modelValue === opt }"
      @click="selectOption(opt)"
    >
      <span class="r-radio">
        <span v-if="modelValue === opt" class="r-radio-dot" />
      </span>
      <span class="r-label">{{ opt }}</span>
      <svg v-if="modelValue === opt"
        xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2.5"
        stroke-linecap="round" stroke-linejoin="round"
        class="r-check">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </button>

    <div v-if="!options.length" class="r-empty">（无可选项）</div>
  </div>
</template>

<script setup>
import { nextTick } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  options:    { type: Array,  default: () => [] },
  extra:      { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:modelValue', 'quick-submit']);

const selectOption = (opt) => {
  emit('update:modelValue', opt);
  nextTick(() => emit('quick-submit'));
};
</script>

<style scoped>
.renderer-select {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.r-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  background: var(--color-bg-secondary);
  border: 1.5px solid var(--color-border);
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
  color: var(--color-text-primary);
  font-size: 0.9rem;
  line-height: 1.4;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
  width: 100%;
  font-family: inherit;
}

.r-option:hover {
  border-color: rgba(var(--color-active-rgb), 0.5);
  background: rgba(var(--color-active-rgb), 0.04);
}

.r-option.active {
  border-color: var(--color-active);
  background: rgba(var(--color-active-rgb), 0.08);
  box-shadow: 0 0 0 1px rgba(var(--color-active-rgb), 0.15);
}

/* 单选圆圈 */
.r-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--color-border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s;
}

.r-option.active .r-radio {
  border-color: var(--color-active);
}

.r-radio-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--color-active);
}

.r-label {
  flex: 1;
  font-weight: 450;
}

/* 已选对勾 */
.r-check {
  color: var(--color-active);
  flex-shrink: 0;
  opacity: 0.85;
}

.r-empty {
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  text-align: center;
  padding: 14px;
  opacity: 0.6;
}
</style>
