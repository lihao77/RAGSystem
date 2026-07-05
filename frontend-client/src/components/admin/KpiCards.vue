<template>
  <div class="grid grid-cols-2 gap-4 md:grid-cols-4">
    <Card
      v-for="(item, index) in items"
      :key="item.key ?? item.label ?? index"
      class="flex flex-row items-center gap-4 p-4"
    >
      <span v-if="item.icon" class="flex shrink-0 text-muted-foreground">
        <component :is="item.icon" />
      </span>
      <div class="min-w-0 space-y-1">
        <span class="block text-xs text-muted-foreground">{{ item.label }}</span>
        <strong class="block text-2xl font-semibold tabular-nums text-foreground">{{ item.value }}</strong>
      </div>
    </Card>
  </div>
</template>

<script setup>
import { Card } from '../ui/card';
/**
 * 管理端 KPI 统计卡片组。每张卡片用 shadcn Card。
 * items 每项: { key?, label, value, icon? }
 */
defineProps({
  items: { type: Array, required: true },
});
</script>
