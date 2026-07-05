<template>
  <div class="situation-bar">
    <div class="bar-left">
      <span class="bar-title">{{ mapData?.title || '态势大屏' }}</span>
      <span class="bar-tag" v-if="mapData?.disaster_type">{{ mapData.disaster_type }}</span>
      <span class="bar-tag type-tag">{{ mapTypeName }}</span>
    </div>
    <div class="bar-center">
      <!-- 风险地图：显示各等级数量 -->
      <template v-if="mapData?.map_type === 'risk' && mapData.assessment_summary">
        <div
          v-for="(count, level) in mapData.assessment_summary"
          :key="level"
          class="stat-card"
          :class="{ 'has-count': count > 0 }"
        >
          <span class="stat-color" :style="{ background: riskColors[level] }">{{ level }}</span>
          <div class="stat-info">
            <span class="stat-value">{{ count }}</span>
            <span class="stat-label">{{ riskLabels[level] }}</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-info">
            <span class="stat-value">{{ mapData.total_points }}</span>
            <span class="stat-label">监测点</span>
          </div>
        </div>
      </template>
      <!-- 多图层地图 -->
      <template v-else-if="mapData?.map_type === 'bindmap'">
        <div class="stat-card">
          <div class="stat-info">
            <span class="stat-value">{{ mapData.total_layers }}</span>
            <span class="stat-label">图层</span>
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-info">
            <span class="stat-value">{{ mapData.total_points }}</span>
            <span class="stat-label">数据点</span>
          </div>
        </div>
      </template>
      <!-- 其他地图 -->
      <template v-else-if="mapData?.total_points">
        <div class="stat-card">
          <div class="stat-info">
            <span class="stat-value">{{ mapData.total_points }}</span>
            <span class="stat-label">数据点</span>
          </div>
        </div>
        <div class="stat-card" v-if="mapData.value_range">
          <div class="stat-info">
            <span class="stat-value">{{ formatNumber(mapData.value_range.max) }}</span>
            <span class="stat-label">最大值</span>
          </div>
        </div>
      </template>
    </div>
    <div class="bar-right">
      <Button variant="ghost" title="退出态势大屏 (ESC)" @click="$emit('close')">
        <IconClose :size="15" />
        <span>退出</span>
      </Button>
    </div>
  </div>
</template>

<script setup>
import IconClose from './icons/IconClose.vue';
import { Button } from './ui/button';
defineProps({
  mapData: { type: Object, default: () => ({}) },
});
defineEmits(['close']);

const riskColors = { I: '#c8504a', II: '#d18246', III: '#c9a445', IV: '#4a78b0' };
const riskLabels = { I: '特别重大', II: '重大', III: '较大', IV: '一般' };

const mapTypeName = (() => {
  return '态势大屏';
})();

const formatNumber = (num) => {
  if (num === null || num === undefined) return '-';
  if (num >= 10000) return (num / 10000).toFixed(2) + '万';
  if (num >= 1000) return (num / 1000).toFixed(2) + '千';
  return Number(num).toFixed(2);
};
</script>

<style scoped>
.situation-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 20px;
  background: var(--color-bg-primary);
  border-bottom: 1px solid var(--color-border);
  color: var(--color-text-primary);
  z-index: 10001;
  min-height: 48px;
}

.bar-left {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
}

.bar-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  letter-spacing: 0.02em;
}

.bar-tag {
  padding: 2px 8px;
  border-radius: var(--radius-full);
  font-size: var(--font-size-xs);
  font-weight: 500;
  background: var(--color-warning-bg);
  color: var(--color-warning);
  border: 1px solid transparent;
}

.type-tag {
  background: var(--color-active-bg);
  color: var(--color-active);
}

.bar-center {
  display: flex;
  align-items: center;
  gap: 12px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px;
  background: var(--color-hover-overlay);
  border-radius: var(--radius-md);
  border: 1px solid var(--color-border);
  transition: background 0.2s;
}

.stat-card:hover {
  background: var(--color-hover-overlay-md);
}

.stat-card.has-count {
  background: var(--color-hover-overlay-md);
}

.stat-info {
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1.2;
}

.stat-color {
  width: 20px;
  height: 20px;
  border-radius: var(--radius-sm);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.55rem;
  font-weight: 700;
  color: var(--color-risk-badge-text);
  flex-shrink: 0;
}

.stat-value {
  font-size: var(--font-size-sm);
  font-weight: 700;
  color: var(--color-text-primary);
}

.stat-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.bar-right {
  flex-shrink: 0;
}

.exit-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  background: var(--color-error-bg);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  color: var(--color-error);
  cursor: pointer;
  font-size: var(--font-size-xs);
  font-weight: 500;
  transition: all 0.2s;
}

.exit-btn:hover {
  background: rgba(var(--color-error-rgb), 0.18);
}

@media (max-width: 767px) {
  .situation-bar {
    padding: 6px 12px;
    flex-wrap: wrap;
    gap: 6px;
  }
  .bar-center {
    order: 3;
    width: 100%;
    justify-content: center;
    flex-wrap: wrap;
    gap: 8px;
  }
  .stat-card {
    padding: 2px 8px;
  }
}
</style>
