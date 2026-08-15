<script setup>
// 胶囊分段控件：统一全项目的 ToggleGroup(variant="segment") + .segmented-track 组合写法。
// options 项：{ value, label, icon?, ariaLabel?, badge?, dot? }
//   icon  — 图标组件（lucide 或本地 Icon*）；badge — 文本/数字角标；dot — 未保存警示点。
// 选中块为滑动指示器：切换时平滑滑向目标项（transform/width 过渡），初始定位不播放动画。
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import StatusDot from '@/components/admin/StatusDot.vue';
import { cn } from '@/lib/utils';

const props = defineProps({
  modelValue: { type: String, required: true },
  options: { type: Array, required: true },
  ariaLabel: { type: String, required: true },
  class: { type: [String, Array, Object], default: '' },
});
const emit = defineEmits(['update:modelValue']);

// single 模式点击已选中项会回传空字符串，统一拦截避免把选中态清空。
function onUpdate(value) {
  if (value) emit('update:modelValue', value);
}

// ---- 滑动指示器 ----
const rootRef = ref(null);
const rootEl = computed(() => rootRef.value?.$el ?? null);
const indicatorStyle = ref(null);
const animated = ref(false);

async function updateIndicator() {
  await nextTick();
  const el = rootEl.value;
  if (!el) return;
  const active = el.querySelector('[data-state="on"]');
  if (!active) { indicatorStyle.value = null; return; }
  indicatorStyle.value = {
    transform: `translate(${active.offsetLeft}px, ${active.offsetTop}px)`,
    width: `${active.offsetWidth}px`,
    height: `${active.offsetHeight}px`,
  };
}

let resizeObserver;
onMounted(async () => {
  await updateIndicator();
  // 初始定位完成后再启用过渡，避免指示器从原点滑入。
  requestAnimationFrame(() => { animated.value = true; });
  resizeObserver = new ResizeObserver(() => updateIndicator());
  if (rootEl.value) resizeObserver.observe(rootEl.value);
});
onBeforeUnmount(() => resizeObserver?.disconnect());

watch(() => props.modelValue, () => updateIndicator());
// 条件项增删 / badge 数字变化会改变项宽，深度监听重新定位。
watch(() => props.options, () => updateIndicator(), { deep: true });
</script>

<template>
  <ToggleGroup
    ref="rootRef"
    type="single"
    variant="segment"
    size="segment"
    :model-value="modelValue"
    :class="cn('segmented-track relative', props.class)"
    :aria-label="ariaLabel"
    @update:model-value="onUpdate"
  >
    <span
      v-if="indicatorStyle"
      aria-hidden="true"
      class="pointer-events-none absolute left-0 top-0 rounded-full bg-primary shadow-sm"
      :class="animated ? 'transition-[transform,width] duration-200 ease-out' : 'transition-none'"
      :style="indicatorStyle"
    />
    <ToggleGroupItem
      v-for="opt in options"
      :key="opt.value"
      :value="opt.value"
      :aria-label="opt.ariaLabel || undefined"
      class="relative z-[1] data-[state=on]:bg-transparent data-[state=on]:shadow-none"
    >
      <component :is="opt.icon" v-if="opt.icon" />
      <span class="whitespace-nowrap">{{ opt.label }}</span>
      <!-- badge 数字：等宽数字 + 切换时淡入淡出，避免项宽随字形突变 -->
      <span v-if="opt.badge !== null && opt.badge !== undefined" class="segmented-control__badge">
        <Transition name="segmented-badge" mode="out-in">
          <span :key="opt.badge" class="segmented-control__badge-num">{{ opt.badge }}</span>
        </Transition>
      </span>
      <!-- dot 零占位：v-if 增删，max-width 展开/收缩 + 透明度过渡，宽度平滑变化不跳变 -->
      <Transition name="segmented-dot">
        <span v-if="opt.dot" class="segmented-control__dot">
          <StatusDot tone="warning" size="sm" />
        </span>
      </Transition>
    </ToggleGroupItem>
  </ToggleGroup>
</template>

<style scoped>
.segmented-control__badge { color: var(--color-text-muted); font-size: 11px; font-variant-numeric: tabular-nums; }
.segmented-control__badge-num { display: inline-block; }

/* badge 数字切换：旧值上飘淡出，新值下飘淡入（out-in 串行，不抢占布局） */
.segmented-badge-enter-active, .segmented-badge-leave-active { transition: opacity 140ms ease, transform 140ms ease; }
.segmented-badge-enter-from { opacity: 0; transform: translateY(4px); }
.segmented-badge-leave-to { opacity: 0; transform: translateY(-4px); }

/* dot 显隐：max-width 展开/收缩（leave 期间元素仍在布局中，平滑让位） */
.segmented-control__dot { display: inline-flex; align-items: center; overflow: hidden; }
.segmented-dot-enter-active, .segmented-dot-leave-active { transition: max-width 180ms ease, opacity 180ms ease; max-width: 12px; }
.segmented-dot-enter-from, .segmented-dot-leave-to { max-width: 0; opacity: 0; }
</style>
