<template>
  <section class="adm-kpi-grid">
    <article
      v-for="(item, index) in items"
      :key="item.key ?? item.label ?? index"
      class="adm-kpi-card"
    >
      <span v-if="item.icon" class="adm-kpi-icon">
        <component :is="item.icon"></component>
      </span>
      <div class="adm-kpi-body">
        <span class="adm-kpi-label">{{ item.label }}</span>
        <strong class="adm-kpi-value">{{ item.value }}</strong>
      </div>
    </article>
  </section>
</template>

<script setup>
/**
 * 管理端 KPI 统计卡片组。消费全局 .adm-kpi-* 类(admin-console.css),
 * 取代各页手写的 summary-grid + 四张卡 + 双轨 summary-* 类名。
 *
 * items 每项:{ key?, label, value, icon? }
 *  - icon 为组件(渲染到 .adm-kpi-icon 内);不传则不显示图标列
 */
defineProps({
  items: { type: Array, required: true },
});
</script>
