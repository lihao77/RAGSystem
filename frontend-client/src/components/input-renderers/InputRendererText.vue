<template>
  <div class="renderer-text">
    <textarea
      ref="textareaRef"
      :value="modelValue"
      class="r-textarea"
      placeholder="在此输入…"
      rows="3"
      @input="handleInput"
      @keydown.ctrl.enter.prevent="$emit('quick-submit')"
      @keydown.meta.enter.prevent="$emit('quick-submit')"
    />
    <div class="r-hint">
      <kbd>Ctrl</kbd><span>+</span><kbd>Enter</kbd><span>发送</span>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  options:    { type: Array,  default: () => [] },
  extra:      { type: Object, default: () => ({}) },
});

const emit = defineEmits(['update:modelValue', 'quick-submit']);

const textareaRef = ref(null);

const handleInput = (e) => {
  emit('update:modelValue', e.target.value);
  const el = e.target;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 220) + 'px';
};

onMounted(() => {
  textareaRef.value?.focus();
});
</script>

<style scoped>
.renderer-text {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.r-textarea {
  width: 100%;
  padding: 11px 13px;
  background: var(--color-bg-secondary);
  border: 1.5px solid var(--color-border);
  border-radius: 10px;
  color: var(--color-text-primary);
  font-size: 0.9rem;
  line-height: 1.65;
  resize: none;
  outline: none;
  transition: border-color 0.15s, box-shadow 0.15s;
  font-family: inherit;
  box-sizing: border-box;
  min-height: 84px;
  max-height: 220px;
  overflow-y: auto;
}

.r-textarea::placeholder {
  color: var(--color-text-secondary);
  opacity: 0.5;
}

.r-textarea:focus {
  border-color: var(--color-accent, #63b3ed);
  box-shadow: 0 0 0 3px rgba(99, 179, 237, 0.12);
}

.r-hint {
  display: flex;
  align-items: center;
  gap: 3px;
  justify-content: flex-end;
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  opacity: 0.65;
}

.r-hint kbd {
  display: inline-flex;
  padding: 1px 5px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-bottom-width: 2px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 0.6875rem;
  line-height: 1.5;
}
</style>
