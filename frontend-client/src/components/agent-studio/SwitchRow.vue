<template>
  <div class="switch-row" :class="{ 'switch-row--on': checked, 'switch-row--disabled': disabled }">
    <span v-if="icon" class="switch-row__icon" aria-hidden="true">
      <component :is="iconComponent" :size="16" />
    </span>
    <div class="switch-row__copy">
      <span class="switch-row__label">{{ label }}</span>
      <span v-if="hint" class="switch-row__hint">{{ hint }}</span>
    </div>
    <Switch :checked="checked" :disabled="disabled" @update:checked="$emit('update:checked', $event)" />
  </div>
</template>

<script setup>
// 卡片化开关行：整行圆角卡片，启用时底色/描边变为 accent 淡色；icon 可选。
import { computed } from 'vue';
import {
  BookOpen, Database, Goal, Layers, RefreshCw,
} from 'lucide-vue-next';
import { Switch } from '../ui/switch';

const props = defineProps({
  label: { type: String, required: true },
  hint: { type: String, default: '' },
  checked: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  icon: { type: String, default: '' }, // lucide 组件名
});
defineEmits(['update:checked']);

const iconMap = { BookOpen, Database, Goal, Layers, RefreshCw };
const iconComponent = computed(() => iconMap[props.icon] || null);
</script>
