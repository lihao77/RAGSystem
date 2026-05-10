<template>
  <div v-if="inputData" class="wpui-root">
    <div class="wpui-section-label">需要输入</div>

    <div class="wpui-card">
      <div class="wpui-prompt">{{ inputData.prompt }}</div>

      <!-- Text -->
      <template v-if="inputType === 'text' || !inputType">
        <textarea
          v-model="textValue"
          class="wpui-textarea"
          :placeholder="inputData.placeholder || '请输入…'"
          rows="3"
          @keydown.ctrl.enter="submit"
          @keydown.meta.enter="submit"
        />
      </template>

      <!-- Select -->
      <template v-else-if="inputType === 'select'">
        <div class="wpui-options">
          <button
            v-for="opt in options"
            :key="opt.value ?? opt"
            class="wpui-option"
            :class="{ selected: selectedValue === (opt.value ?? opt) }"
            @click="selectedValue = (opt.value ?? opt)"
          >{{ opt.label ?? opt }}</button>
        </div>
      </template>

      <div class="wpui-actions">
        <button class="wpui-btn wpui-btn--submit" @click="submit">发送</button>
        <button class="wpui-btn wpui-btn--cancel" @click="emit('cancel')">停止</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'

const props = defineProps({
  inputData: { type: Object, default: null },
})
const emit = defineEmits(['submit', 'cancel'])

const textValue = ref('')
const selectedValue = ref(null)
const inputType = computed(() => props.inputData?.input_type)
const options = computed(() => props.inputData?.options || [])

watch(() => props.inputData, () => { textValue.value = ''; selectedValue.value = null })

function submit() {
  if (!props.inputData?.input_id) return
  const value = inputType.value === 'select' ? selectedValue.value : textValue.value
  emit('submit', { inputId: props.inputData.input_id, value })
  textValue.value = ''
  selectedValue.value = null
}
</script>

<style scoped>
.wpui-root {
  padding: 6px 14px 12px;
  background: transparent;
  border-top: 1px solid var(--color-border);
  letter-spacing: 0;
}

.wpui-section-label {
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--color-brand-accent, #6366f1);
  margin-bottom: 8px;
}

.wpui-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm, 8px);
  overflow: hidden;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.82);
  box-shadow: var(--shadow-md);
}

.wpui-prompt {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  line-height: 1.5;
  padding: 10px 12px 8px;
  border-bottom: 1px solid var(--color-border);
}

.wpui-textarea {
  width: 100%;
  font-size: 13px;
  padding: 8px 12px;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.16);
  border: none;
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-primary);
  outline: none;
  resize: none;
  font-family: var(--font-sans);
  box-sizing: border-box;
  line-height: 1.5;
}

.wpui-textarea::placeholder { color: var(--color-text-muted); }

.wpui-options {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border);
}

.wpui-option {
  padding: 5px 12px;
  border-radius: 20px;
  font-size: 12px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.12s;
}

.wpui-option:hover {
  border-color: var(--color-brand-accent, #6366f1);
  color: var(--color-brand-accent, #6366f1);
}

.wpui-option.selected {
  background: rgba(var(--color-brand-accent-rgb, 99,102,241), 0.12);
  border-color: var(--color-brand-accent, #6366f1);
  color: var(--color-brand-accent, #6366f1);
  font-weight: 600;
}

.wpui-actions {
  display: flex;
}

.wpui-btn {
  flex: 1;
  padding: 8px 0;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  border: none;
  background: transparent;
  transition: background 0.12s;
}
.wpui-btn:active { transform: scale(0.98); }

.wpui-btn--submit {
  color: var(--color-brand-accent, #6366f1);
  border-right: 1px solid var(--color-border);
}
.wpui-btn--submit:hover {
  background: rgba(var(--color-brand-accent-rgb, 99,102,241), 0.08);
}

.wpui-btn--cancel {
  color: var(--color-text-muted);
}
.wpui-btn--cancel:hover {
  background: var(--color-hover-overlay, rgba(255,255,255,0.04));
}
</style>
