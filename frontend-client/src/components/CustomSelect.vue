<template>
  <div class="custom-select" ref="rootRef">
    <div
      class="select-trigger"
      :class="{ open: isOpen, disabled: disabled }"
      @click="toggle"
    >
      <span class="trigger-text" :class="{ placeholder: !hasValue }">
        {{ displayLabel }}
      </span>
      <svg
        class="arrow-icon"
        :class="{ rotate: isOpen }"
        xmlns="http://www.w3.org/2000/svg"
        width="16" height="16"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </div>

    <transition name="dropdown">
      <div v-if="isOpen" class="dropdown-menu">
        <div class="options-list">
          <div
            v-for="opt in options"
            :key="opt.value"
            class="option-item"
            :class="{ selected: opt.value === modelValue }"
            @click="select(opt)"
          >
            <span class="option-label">{{ opt.label }}</span>
            <svg
              v-if="opt.value === modelValue"
              class="check-icon"
              xmlns="http://www.w3.org/2000/svg"
              width="14" height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="2.5"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div v-if="options.length === 0" class="no-options">暂无选项</div>
        </div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] }, // [{ value, label }]
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
});

const emit = defineEmits(['update:modelValue', 'change']);

const rootRef = ref(null);
const isOpen = ref(false);

const hasValue = computed(() => props.modelValue !== '' && props.modelValue != null);

const displayLabel = computed(() => {
  if (!hasValue.value) return props.placeholder;
  const found = props.options.find(o => o.value === props.modelValue);
  return found ? found.label : props.modelValue;
});

const toggle = () => {
  if (props.disabled) return;
  isOpen.value = !isOpen.value;
};

const select = (opt) => {
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  isOpen.value = false;
};

const onClickOutside = (e) => {
  if (rootRef.value && !rootRef.value.contains(e.target)) {
    isOpen.value = false;
  }
};

onMounted(() => document.addEventListener('click', onClickOutside, true));
onUnmounted(() => document.removeEventListener('click', onClickOutside, true));
</script>

<style scoped>
.custom-select {
  position: relative;
  width: 100%;
}

/* ── Trigger ── */
.select-trigger {
  display: flex;
  align-items: center;
  height: 42px;
  padding: 0 40px 0 14px;
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.05em;
  cursor: pointer;
  user-select: none;
  transition: all var(--transition-normal);
  position: relative;
}

.select-trigger:hover:not(.disabled) {
  background: var(--color-interactive-hover);
  border-color: var(--color-border-hover);
}

.select-trigger.open {
  border-color: var(--color-border-focus);
}

.select-trigger.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.trigger-text {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.trigger-text.placeholder {
  color: var(--color-text-muted);
}

.arrow-icon {
  position: absolute;
  right: 14px;
  top: 50%;
  transform: translateY(-50%);
  transition: transform var(--transition-normal);
  pointer-events: none;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.arrow-icon.rotate {
  transform: translateY(-50%) rotate(180deg);
}

/* ── Dropdown ── */
.dropdown-menu {
  position: absolute;
  top: calc(100% + 8px);
  left: 0;
  right: 0;
  min-width: 100%;
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45), 0 0 0 1px rgba(255,255,255,0.04);
  z-index: 200;
  overflow: hidden;
}

.options-list {
  max-height: 260px;
  overflow-y: auto;
  padding: 6px;
}

.option-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  cursor: pointer;
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
  transition: background var(--transition-fast);
}

.option-item:hover {
  background: var(--color-interactive-hover);
}

.option-item.selected {
  background: rgba(var(--color-brand-accent-rgb), 0.1);
  font-weight: 600;
}

.option-label {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.check-icon {
  flex-shrink: 0;
  color: var(--color-success);
}

.no-options {
  padding: 16px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 13px;
}

/* ── Scrollbar ── */
.options-list::-webkit-scrollbar { width: 5px; }
.options-list::-webkit-scrollbar-track { background: transparent; }
.options-list::-webkit-scrollbar-thumb {
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-full);
}
.options-list::-webkit-scrollbar-thumb:hover { background: var(--color-text-muted); }

/* ── Animation — 与 LLMSelector 完全一致 ── */
.dropdown-enter-active {
  animation: dropdownIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.dropdown-leave-active {
  animation: dropdownOut 0.15s cubic-bezier(0.4, 0, 1, 1);
}

@keyframes dropdownIn {
  from { opacity: 0; transform: translateY(-8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0)   scale(1);    }
}
@keyframes dropdownOut {
  from { opacity: 1; transform: translateY(0)   scale(1);    }
  to   { opacity: 0; transform: translateY(-8px) scale(0.96); }
}
</style>
