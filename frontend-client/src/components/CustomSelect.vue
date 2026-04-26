<template>
  <div class="custom-select" ref="rootRef">
    <div
      ref="triggerRef"
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
        width="16"
        height="16"
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

    <Teleport to="body">
      <transition :name="dropdownTransitionName">
        <div
          v-if="isOpen"
          ref="dropdownRef"
          class="dropdown-menu dropdown-menu--teleported"
          :class="`dropdown-menu--${resolvedPlacement}`"
          :style="dropdownStyle"
        >
          <div class="options-list" :style="optionsListStyle">
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
                width="14"
                height="14"
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
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { usePointerDownOutside, usePointerInsideRegistry } from '../composables/usePointerDownOutside';

const DEFAULT_DROPDOWN_MAX_HEIGHT = 260;
const DROPDOWN_OFFSET = 8;
const VIEWPORT_PADDING = 12;

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  dropdownMaxHeight: { type: [Number, String], default: DEFAULT_DROPDOWN_MAX_HEIGHT },
  dropdownPlacement: {
    type: String,
    default: 'auto',
    validator: value => ['auto', 'up', 'down'].includes(value),
  },
});

const emit = defineEmits(['update:modelValue', 'change']);

const rootRef = ref(null);
const triggerRef = ref(null);
const dropdownRef = ref(null);
const isOpen = ref(false);
const resolvedPlacement = ref('down');
const dropdownPosition = ref({ top: 0, left: 0, width: 0 });

const normalizedDropdownMaxHeight = computed(() => {
  const numericValue = Number(props.dropdownMaxHeight);
  return Number.isFinite(numericValue) && numericValue > 0
    ? numericValue
    : DEFAULT_DROPDOWN_MAX_HEIGHT;
});

const hasValue = computed(() => props.modelValue !== '' && props.modelValue != null);

const displayLabel = computed(() => {
  if (!hasValue.value) return props.placeholder;
  const found = props.options.find(o => o.value === props.modelValue);
  return found ? found.label : props.modelValue;
});

const dropdownStyle = computed(() => ({
  top: `${dropdownPosition.value.top}px`,
  left: `${dropdownPosition.value.left}px`,
  width: `${dropdownPosition.value.width}px`,
}));

const optionsListStyle = computed(() => ({
  maxHeight: `${normalizedDropdownMaxHeight.value}px`,
}));

const dropdownTransitionName = computed(() => (
  resolvedPlacement.value === 'up' ? 'dropdown-up' : 'dropdown-down'
));

const updateDropdownPosition = () => {
  if (!triggerRef.value) return;

  const rect = triggerRef.value.getBoundingClientRect();
  const dropdownHeight = dropdownRef.value?.offsetHeight ?? normalizedDropdownMaxHeight.value;
  const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_PADDING;
  const spaceAbove = rect.top - VIEWPORT_PADDING;

  let placement = props.dropdownPlacement;
  if (placement === 'auto') {
    placement = spaceBelow >= dropdownHeight || spaceBelow >= spaceAbove ? 'down' : 'up';
  }

  resolvedPlacement.value = placement;

  const unclampedTop = placement === 'up'
    ? rect.top - dropdownHeight - DROPDOWN_OFFSET
    : rect.bottom + DROPDOWN_OFFSET;
  const maxTop = Math.max(VIEWPORT_PADDING, window.innerHeight - dropdownHeight - VIEWPORT_PADDING);

  dropdownPosition.value = {
    top: Math.min(Math.max(unclampedTop, VIEWPORT_PADDING), maxTop),
    left: rect.left,
    width: rect.width,
  };
};

const openDropdown = async () => {
  isOpen.value = true;
  await nextTick();
  updateDropdownPosition();
};

const closeDropdown = () => {
  isOpen.value = false;
};

const toggle = async () => {
  if (props.disabled) return;
  if (isOpen.value) {
    closeDropdown();
    return;
  }
  await openDropdown();
};

const select = (opt) => {
  emit('update:modelValue', opt.value);
  emit('change', opt.value);
  closeDropdown();
};

usePointerDownOutside({
  inside: [rootRef, dropdownRef],
  enabled: () => isOpen.value,
  onOutside: closeDropdown,
});

usePointerInsideRegistry([dropdownRef], () => isOpen.value);

const onWindowChange = () => {
  if (isOpen.value) {
    updateDropdownPosition();
  }
};

watch(() => props.options, () => {
  if (isOpen.value) {
    nextTick(updateDropdownPosition);
  }
}, { deep: true });

watch(() => [props.dropdownMaxHeight, props.dropdownPlacement], () => {
  if (isOpen.value) {
    nextTick(updateDropdownPosition);
  }
});

onMounted(() => {
  window.addEventListener('resize', onWindowChange);
  window.addEventListener('scroll', onWindowChange, true);
});

onUnmounted(() => {
  window.removeEventListener('resize', onWindowChange);
  window.removeEventListener('scroll', onWindowChange, true);
});
</script>

<style scoped>
.custom-select {
  position: relative;
  width: 100%;
}

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
  transition: all 0.3s;
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
  transition: transform 0.3s;
  pointer-events: none;
  color: var(--color-text-secondary);
  flex-shrink: 0;
}

.arrow-icon.rotate {
  transform: translateY(-50%) rotate(180deg);
}

.dropdown-menu {
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg), 0 0 0 1px var(--color-hover-overlay);
  overflow: hidden;
}

.dropdown-menu--teleported {
  position: fixed;
  z-index: 9999;
}

.dropdown-menu--up {
  transform-origin: bottom center;
}

.dropdown-menu--down {
  transform-origin: top center;
}

.options-list {
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
  transition: background 0.2s;
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

.options-list::-webkit-scrollbar { width: 5px; }
.options-list::-webkit-scrollbar-track { background: transparent; }
.options-list::-webkit-scrollbar-thumb {
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-full);
}
.options-list::-webkit-scrollbar-thumb:hover { background: var(--color-text-muted); }

.dropdown-down-enter-active {
  animation: dropdownDownIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.dropdown-down-leave-active {
  animation: dropdownDownOut 0.15s cubic-bezier(0.4, 0, 1, 1);
}
.dropdown-up-enter-active {
  animation: dropdownUpIn 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}
.dropdown-up-leave-active {
  animation: dropdownUpOut 0.15s cubic-bezier(0.4, 0, 1, 1);
}

@keyframes dropdownDownIn {
  from { opacity: 0; transform: translateY(-8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dropdownDownOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to   { opacity: 0; transform: translateY(-8px) scale(0.96); }
}

@keyframes dropdownUpIn {
  from { opacity: 0; transform: translateY(8px) scale(0.96); }
  to   { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes dropdownUpOut {
  from { opacity: 1; transform: translateY(0) scale(1); }
  to   { opacity: 0; transform: translateY(8px) scale(0.96); }
}
</style>
