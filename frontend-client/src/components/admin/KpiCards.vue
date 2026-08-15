<template>
  <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
    <Card
      v-for="(item, index) in items"
      :key="item.key ?? item.label ?? index"
      class="kpi-card p-4"
      :style="{ '--i': index }"
    >
      <div class="kpi-head">
        <span v-if="item.icon" class="kpi-icon" aria-hidden="true">
          <component :is="item.icon" :size="14" />
        </span>
        <span class="kpi-label truncate">{{ item.label }}</span>
      </div>
      <strong class="kpi-value block truncate" :class="item.tone ? `kpi-value--${item.tone}` : ''">{{ displayed[index] ?? item.value }}</strong>
    </Card>
  </div>
</template>

<script setup>
import { onBeforeUnmount, ref, watch } from 'vue';
import { Card } from '../ui/card';
/**
 * 管理端 KPI 统计卡片组。每张卡片用 shadcn Card。
 * items 每项: { key?, label, value, icon?, tone? }
 * value 为整数时带 count-up 动画（尊重 prefers-reduced-motion），其余原样显示。
 * tone: 'success' | 'warning' | 'error' —— 数值语义着色（成功率、错误数等）。
 */
const props = defineProps({
  items: { type: Array, required: true },
});

const displayed = ref(props.items.map((item) => item.value));
const reduceMotion = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const COUNT_UP_MS = 520;
let rafId = 0;

function toInt(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number.parseInt(value, 10);
  return null;
}

watch(
  () => props.items.map((item) => item.value),
  (targets) => {
    cancelAnimationFrame(rafId);
    if (reduceMotion) {
      displayed.value = [...targets];
      return;
    }
    const from = displayed.value.map((value, i) => {
      const current = toInt(value);
      return current !== null && toInt(targets[i]) !== null ? current : null;
    });
    const start = performance.now();
    const tick = (now) => {
      const t = Math.min(1, (now - start) / COUNT_UP_MS);
      const eased = 1 - Math.pow(1 - t, 3);
      displayed.value = targets.map((target, i) => {
        const targetInt = toInt(target);
        if (targetInt === null) return target;
        const base = from[i] ?? 0;
        return t >= 1 ? target : Math.round(base + (targetInt - base) * eased);
      });
      if (t < 1) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  },
);

onBeforeUnmount(() => cancelAnimationFrame(rafId));
</script>

<style scoped>
.kpi-card {
  border-color: var(--color-border);
  animation: kpi-card-in var(--duration-base) var(--ease-out-expo) backwards;
  animation-delay: calc(var(--i, 0) * 45ms);
  transition:
    border-color var(--transition-fast),
    background-color var(--transition-fast);
}

.kpi-card:hover {
  border-color: var(--color-border-hover);
}

/* 头部：图标与标签同行 */
.kpi-head {
  display: flex;
  align-items: baseline;
  gap: var(--spacing-xs);
  min-width: 0;
  margin-bottom: var(--spacing-xs);
}

.kpi-icon {
  position: relative;
  top: 0.125em;
  flex-shrink: 0;
  color: var(--color-text-secondary);
}

.kpi-label {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-secondary);
}

.kpi-value {
  font-size: 1.625rem;
  font-weight: 650;
  line-height: 1.2;
  font-variant-numeric: tabular-nums;
  color: var(--color-text-primary);
}

.kpi-value--success { color: var(--color-success); }
.kpi-value--warning { color: var(--color-warning); }
.kpi-value--error { color: var(--color-error); }

@keyframes kpi-card-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }

  to {
    opacity: 1;
    transform: none;
  }
}
</style>
