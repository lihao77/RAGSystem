<template>
  <div class="combo-box" :class="{ open, disabled }">
    <input
      :id="triggerId || undefined"
      ref="inputRef"
      class="combo-box__input"
      :value="modelValue"
      :placeholder="placeholder"
      :disabled="disabled"
      role="combobox"
      aria-autocomplete="list"
      :aria-expanded="open"
      :aria-controls="listId"
      :aria-invalid="ariaInvalid || undefined"
      autocomplete="off"
      spellcheck="false"
      @input="onInput"
      @focus="onFocus"
      @blur="open = false"
      @keydown="onKeydown"
    />
    <button
      type="button"
      class="combo-box__toggle"
      aria-label="展开选项"
      :disabled="disabled || options.length === 0"
      tabindex="-1"
      @mousedown.prevent="toggleOpen"
    >
      <IconChevronDown :size="14" class="combo-box__arrow" :class="{ rotate: open }" />
    </button>

    <div v-if="open" :id="listId" role="listbox" class="combo-box__panel">
      <button
        v-for="(opt, idx) in shownOptions"
        :key="opt.value"
        type="button"
        role="option"
        :aria-selected="opt.value === modelValue"
        class="combo-box__option"
        :class="{ active: idx === activeIndex, selected: opt.value === modelValue }"
        @mousedown.prevent="pick(opt)"
      >
        <span class="combo-box__option-label">{{ opt.label }}</span>
        <IconCheck v-if="opt.value === modelValue" :size="14" class="combo-box__check" />
      </button>
      <div v-if="shownOptions.length === 0" class="combo-box__empty">{{ emptyText }}</div>
      <div v-else-if="filteredOptions.length > shownOptions.length" class="combo-box__more">
        已显示前 {{ shownOptions.length }} 项，输入关键字过滤
      </div>
    </div>
  </div>
</template>

<script setup>
// 可输入 + 可下拉的组合框：文本即值（厂商 id / 模型 id），目录选项只做建议；
// 键入自由过滤（value+label 子串匹配），从下拉选中才发 pick（供目录联动副作用）。
import { computed, ref } from 'vue';
import IconChevronDown from '../icons/IconChevronDown.vue';
import IconCheck from '../icons/IconCheck.vue';

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '' },
  emptyText: { type: String, default: '无匹配选项，可继续手动输入' },
  disabled: { type: Boolean, default: false },
  triggerId: { type: String, default: '' },
  maxOptions: { type: Number, default: 60 },
  // 声明成 prop 以落到 input 上（否则透传到根 div，读屏无效）
  ariaInvalid: { type: Boolean, default: false },
});

const emit = defineEmits(['update:modelValue', 'pick']);

const inputRef = ref(null);
const open = ref(false);
const activeIndex = ref(-1);
const listId = `combo-box-list-${Math.random().toString(36).slice(2, 8)}`;

const filteredOptions = computed(() => {
  const query = String(props.modelValue || '').trim().toLowerCase();
  if (!query) return props.options;
  return props.options.filter((opt) => {
    const value = String(opt?.value || '').toLowerCase();
    const label = String(opt?.label || '').toLowerCase();
    return value.includes(query) || label.includes(query);
  });
});
const shownOptions = computed(() => filteredOptions.value.slice(0, props.maxOptions));

function onInput(event) {
  emit('update:modelValue', event.target.value);
  activeIndex.value = shownOptions.value.length > 0 ? 0 : -1;
  // 无选项（目录不可用）时不弹面板，退化为纯输入框。
  open.value = filteredOptions.value.length > 0;
}

function onFocus() {
  if (props.disabled) return;
  activeIndex.value = shownOptions.value.length > 0 ? 0 : -1;
  open.value = filteredOptions.value.length > 0;
}

function onKeydown(event) {
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (filteredOptions.value.length === 0) return;
    open.value = true;
    const count = shownOptions.value.length;
    const delta = event.key === 'ArrowDown' ? 1 : -1;
    activeIndex.value = (activeIndex.value + delta + count) % count;
  } else if (event.key === 'Enter' && open.value) {
    const opt = shownOptions.value[activeIndex.value];
    if (opt) {
      event.preventDefault();
      pick(opt);
    }
  } else if (event.key === 'Escape') {
    open.value = false;
  } else if (event.key === 'Tab') {
    open.value = false;
  }
}

function pick(opt) {
  emit('update:modelValue', opt.value);
  emit('pick', opt);
  open.value = false;
}

function toggleOpen() {
  if (props.options.length === 0) return;
  open.value = !open.value;
  if (open.value) {
    activeIndex.value = shownOptions.value.length > 0 ? 0 : -1;
    inputRef.value?.focus();
  }
}
</script>

<style scoped>
.combo-box { position: relative; width: 100%; }
.combo-box__input {
  width: 100%;
  height: var(--control-height-md);
  /* 左侧 12px 对齐 shadcn Input 的 px-3；右侧 32px 给下拉箭头留位 */
  padding: 0 32px 0 12px;
  border: 1px solid var(--color-border);
  border-radius: var(--control-radius);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
}
.combo-box__input::placeholder { color: var(--color-text-muted); font-weight: 400; }
.combo-box__input:hover:not(:disabled) { border-color: var(--color-border-hover); }
.combo-box__input:focus { outline: none; border-color: var(--color-brand-accent); box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.12); }
.combo-box.disabled { opacity: 0.55; }
.combo-box__toggle {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
}
.combo-box__toggle:disabled { cursor: default; opacity: 0.6; }
.combo-box__arrow { transition: transform 0.3s; }
.combo-box__arrow.rotate { transform: rotate(180deg); }

.combo-box__panel {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 40;
  width: max-content;
  min-width: 100%;
  max-width: min(420px, 90vw);
  max-height: 260px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border-radius: var(--radius-lg);
  border: var(--glass-border-width) var(--glass-border-style) var(--glass-border-color);
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: var(--glass-shadow);
}
.combo-box__option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 10px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  text-align: left;
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
  cursor: pointer;
}
.combo-box__option.active { background: var(--color-hover-overlay-md); }
.combo-box__option.selected { background: var(--color-active-bg); color: var(--color-brand-accent); font-weight: 600; }
.combo-box__option-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.combo-box__check { flex-shrink: 0; color: inherit; }
.combo-box__empty, .combo-box__more { padding: 10px 12px; color: var(--color-text-muted); font-size: var(--font-size-xs); text-align: center; }
</style>
