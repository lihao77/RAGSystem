<template>
  <div class="number-input" :class="{ disabled }">
    <button
      class="step-btn"
      type="button"
      :disabled="disabled || internalValue <= min"
      @click="step(-1)"
      tabindex="-1"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>

    <input
      ref="inputRef"
      class="number-input__field"
      type="number"
      :value="internalValue"
      :min="min"
      :max="max"
      :step="step_"
      :disabled="disabled"
      :placeholder="placeholder"
      @input="onInput"
      @blur="onBlur"
    />

    <button
      class="step-btn"
      type="button"
      :disabled="disabled || internalValue >= max"
      @click="step(1)"
      tabindex="-1"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="5" x2="12" y2="19"/>
        <line x1="5" y1="12" x2="19" y2="12"/>
      </svg>
    </button>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';

const props = defineProps({
  modelValue: { type: Number, default: 0 },
  min:        { type: Number, default: -Infinity },
  max:        { type: Number, default: Infinity },
  step:       { type: Number, default: 1 },
  disabled:   { type: Boolean, default: false },
  placeholder:{ type: String, default: '' },
});

const emit = defineEmits(['update:modelValue']);

// 用 step_ 避免与方法名冲突
const step_ = computed(() => props.step);

const internalValue = computed(() => props.modelValue);

function clamp(val) {
  if (props.min !== -Infinity && val < props.min) return props.min;
  if (props.max !== Infinity  && val > props.max) return props.max;
  return val;
}

function step(dir) {
  const next = clamp((props.modelValue ?? 0) + dir * props.step);
  emit('update:modelValue', next);
}

function onInput(e) {
  const raw = parseFloat(e.target.value);
  if (!isNaN(raw)) emit('update:modelValue', raw);
}

function onBlur(e) {
  const raw = parseFloat(e.target.value);
  const val = isNaN(raw) ? (props.min !== -Infinity ? props.min : 0) : clamp(raw);
  emit('update:modelValue', val);
  e.target.value = val;
}
</script>

<style scoped>
.number-input {
  display: flex;
  align-items: center;
  height: 42px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  overflow: hidden;
  transition: border-color var(--transition-fast);
}

.number-input:focus-within {
  border-color: var(--color-border-focus);
}

.number-input.disabled {
  opacity: 0.5;
  pointer-events: none;
}

/* ── 步进按钮 ── */
.step-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 34px;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.step-btn:hover:not(:disabled) {
  background: var(--color-interactive-hover);
  color: var(--color-text-primary);
}

.step-btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}

.step-btn:first-child {
  border-right: 1px solid var(--color-border);
}

.step-btn:last-child {
  border-left: 1px solid var(--color-border);
}

/* ── 输入框 ── */
.number-input__field {
  flex: 1;
  min-width: 0;
  height: 100%;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.02em;
  text-align: center;
  outline: none;
  padding: 0 4px;
}

.number-input__field::placeholder {
  color: var(--color-text-muted);
  font-weight: 400;
}

/* 隐藏原生箭头 */
.number-input__field::-webkit-outer-spin-button,
.number-input__field::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}
.number-input__field {
  -moz-appearance: textfield;
  appearance: textfield;
}
</style>
