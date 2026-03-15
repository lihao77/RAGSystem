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
          <span class="stat-value">{{ count }}</span>
          <span class="stat-label">{{ riskLabels[level] }}</span>
        </div>
        <div class="stat-card stat-total">
          <span class="stat-value">{{ mapData.total_points }}</span>
          <span class="stat-label">监测点</span>
        </div>
      </template>
      <!-- 多图层地图：显示图层数和数据点 -->
      <template v-else-if="mapData?.map_type === 'bindmap'">
        <div class="stat-card">
          <span class="stat-value">{{ mapData.total_layers }}</span>
          <span class="stat-label">图层</span>
        </div>
        <div class="stat-card">
          <span class="stat-value">{{ mapData.total_points }}</span>
          <span class="stat-label">数据点</span>
        </div>
      </template>
      <!-- 其他地图 -->
      <template v-else-if="mapData?.total_points">
        <div class="stat-card">
          <span class="stat-value">{{ mapData.total_points }}</span>
          <span class="stat-label">数据点</span>
        </div>
        <div class="stat-card" v-if="mapData.value_range">
          <span class="stat-value">{{ formatNumber(mapData.value_range.max) }}</span>
          <span class="stat-label">最大值</span>
        </div>
      </template>
    </div>
    <div class="bar-right">
      <button class="exit-btn" @click="$emit('close')" title="退出态势大屏 (ESC)">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
        <span>退出</span>
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  mapData: { type: Object, default: () => ({}) },
});
defineEmits(['close']);

const riskColors = { I: '#d32f2f', II: '#ff9800', III: '#fdd835', IV: '#1976d2' };
const riskLabels = { I: '特别重大', II: '重大', III: '较大', IV: '一般' };

const mapTypeName = (() => {
  // computed-like but as a simple reactive string is fine for static prop
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
  background: rgba(15, 15, 25, 0.85);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  color: #fff;
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
  font-size: 0.95rem;
  font-weight: 700;
  letter-spacing: 0.02em;
}

.bar-tag {
  padding: 2px 10px;
  border-radius: 12px;
  font-size: 0.7rem;
  font-weight: 600;
  background: rgba(255, 152, 0, 0.2);
  color: #ff9800;
  border: 1px solid rgba(255, 152, 0, 0.3);
}

.type-tag {
  background: rgba(33, 150, 243, 0.2);
  color: #2196f3;
  border-color: rgba(33, 150, 243, 0.3);
}

.bar-center {
  display: flex;
  align-items: center;
  gap: 16px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.stat-card.has-count {
  background: rgba(255, 255, 255, 0.08);
}

.stat-color {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.6rem;
  font-weight: bold;
  color: #fff;
  flex-shrink: 0;
}

.stat-value {
  font-size: 1rem;
  font-weight: 700;
  color: #fff;
}

.stat-label {
  font-size: 0.7rem;
  color: rgba(255, 255, 255, 0.6);
}

.stat-total {
  border-color: rgba(33, 150, 243, 0.3);
}

.bar-right {
  flex-shrink: 0;
}

.exit-btn {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 14px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.8);
  cursor: pointer;
  font-size: 0.8rem;
  transition: all 0.2s;
}

.exit-btn:hover {
  background: rgba(244, 67, 54, 0.2);
  border-color: rgba(244, 67, 54, 0.4);
  color: #f44336;
}

@media (max-width: 768px) {
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
