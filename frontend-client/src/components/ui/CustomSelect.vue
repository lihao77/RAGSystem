<template>
  <div ref="wrapperRef" class="custom-select">
    <Select :model-value="selectValue" :disabled="disabled" @update:model-value="onChange">
      <SelectTrigger
        :id="triggerId || undefined"
        :aria-label="triggerAriaLabel || undefined"
        class="select-trigger"
        :class="{ disabled }"
      >
        <SelectValue :placeholder="placeholder" />
      </SelectTrigger>
      <SelectContent :side="side" :style="contentStyle" class="dropdown-menu">
        <SelectGroup>
          <SelectItem v-for="opt in options" :key="opt.value" :value="itemValue(opt.value)" class="option-item">
            {{ opt.label }}
          </SelectItem>
        </SelectGroup>
        <div v-if="options.length === 0" class="no-options">暂无选项</div>
      </SelectContent>
    </Select>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectGroup, SelectItem } from './select';

// reka SelectItem 禁 value=''（会抛错），用 sentinel 在组件边界做 '' <-> NONE 映射。
const NONE = '__custom_select_none__';

const props = defineProps({
  modelValue: { type: String, default: '' },
  options: { type: Array, default: () => [] },
  placeholder: { type: String, default: '请选择' },
  disabled: { type: Boolean, default: false },
  triggerId: { type: String, default: '' },
  triggerAriaLabel: { type: String, default: '' },
  dropdownMaxHeight: { type: [Number, String], default: 260 },
  dropdownMinWidth: { type: [Number, String], default: '' },
  dropdownMaxWidth: { type: [Number, String], default: '' },
  dropdownPlacement: {
    type: String,
    default: 'auto',
    validator: value => ['auto', 'up', 'down'].includes(value),
  },
});

const emit = defineEmits(['update:modelValue', 'change']);

// reka SelectItem value 禁 ''，映射 '' -> NONE。
function itemValue(v) {
  return v === '' || v == null ? NONE : v;
}

// modelValue='' 视为未选 -> undefined 让 SelectValue 显示 placeholder。
const selectValue = computed(() => {
  const v = props.modelValue;
  if (v === '' || v == null) return undefined;
  return v;
});

// dropdownPlacement(up/down/auto) -> reka SelectContent side(top/bottom/undefined)。
const sideMap = { up: 'top', down: 'bottom' };
const side = computed(() => sideMap[props.dropdownPlacement]);

// 尺寸 prop -> CSS 值。数字当 px，非数字字符串（'220px'/'14rem'）原样透传。
function toSize(val, fallback = '') {
  if (val === '' || val == null) return fallback;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? `${n}px` : String(val);
}

// 测量 wrapper 宽度（= trigger 宽，SelectTrigger w-full 撑满 wrapper）。
const wrapperRef = ref(null);
const triggerWidth = ref(0);
let resizeObserver = null;
onMounted(() => {
  if (!wrapperRef.value) return;
  const measure = () => { triggerWidth.value = wrapperRef.value?.offsetWidth || 0; };
  measure();
  resizeObserver = new ResizeObserver(measure);
  resizeObserver.observe(wrapperRef.value);
});
onBeforeUnmount(() => {
  resizeObserver?.disconnect();
  resizeObserver = null;
});

// 面板宽度：默认严格跟随 trigger；dropdownMin/Max 显式覆盖其一侧时，另一侧放开。
const contentStyle = computed(() => {
  const tw = triggerWidth.value ? `${triggerWidth.value}px` : undefined;
  const minW = toSize(props.dropdownMinWidth);
  const maxW = toSize(props.dropdownMaxWidth);
  const style = { maxHeight: toSize(props.dropdownMaxHeight, '260px') };
  if (tw) style.width = tw;
  style.minWidth = minW || (maxW ? undefined : tw);
  style.maxWidth = maxW || (minW ? undefined : tw);
  return style;
});

function onChange(value) {
  const real = value === NONE ? '' : value;
  emit('update:modelValue', real);
  emit('change', real);
}
</script>

<style scoped>
.custom-select {
  position: relative;
  width: 100%;
}

/* trigger：对齐项目 token，覆盖 shadcn SelectTrigger 默认 */
.select-trigger {
  height: var(--control-height-md);
  border-radius: var(--control-radius);
  border-color: var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 500;
}
.select-trigger:hover:not(.disabled) {
  border-color: var(--color-border-hover);
}
.select-trigger[data-state=open] {
  border-color: var(--color-brand-accent);
  box-shadow: 0 0 0 3px rgba(var(--color-brand-accent-rgb), 0.12);
}
.select-trigger.disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.select-trigger[data-placeholder] {
  color: var(--color-text-muted);
}
/* 内置 chevron：open 时旋转 */
.select-trigger :deep(svg) {
  transition: transform 0.3s;
  color: var(--color-text-secondary);
  opacity: 1;
}
.select-trigger[data-state=open] :deep(svg) {
  transform: rotate(180deg);
}

/* 内容面板：glass；宽度由 inline style 跟随 trigger（见 contentStyle） */
.dropdown-menu {
  border-radius: var(--radius-lg);
  border: var(--glass-border-width) var(--glass-border-style) var(--glass-border-color);
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  box-shadow: var(--glass-shadow);
}

/* 选项 */
.option-item {
  padding: 9px 32px 9px 12px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: 500;
  color: var(--color-text-primary);
}
.option-item[data-highlighted] {
  background: var(--color-hover-overlay-md);
}
.option-item[data-state=checked] {
  background: var(--color-active-bg);
  color: var(--color-brand-accent);
  font-weight: 600;
}
/* SelectItemText（最后一个 span）：truncate，避免长 label 和右侧 check 重叠 */
.option-item :deep(span:last-child) {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.no-options {
  padding: 16px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 13px;
}
</style>
