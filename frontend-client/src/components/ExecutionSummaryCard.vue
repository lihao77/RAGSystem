<template>
  <div v-if="summary" class="execution-summary-card">
    <div class="summary-header">
      <span class="summary-icon">{{ summary.success ? '✅' : '⚠️' }}</span>
      <span class="summary-title">执行摘要</span>
      <span class="summary-badge" :class="{ success: summary.success, failed: !summary.success }">
        {{ summary.success ? '全部完成' : '部分失败' }}
      </span>
    </div>

    <div class="summary-content">
      <!-- 统计指标 -->
      <div class="metrics-grid">
        <div class="metric-item">
          <div class="metric-value">{{ summary.total_tasks }}</div>
          <div class="metric-label">总任务数</div>
        </div>

        <div class="metric-item success">
          <div class="metric-value">{{ summary.completed_tasks }}</div>
          <div class="metric-label">✅ 已完成</div>
        </div>

        <div class="metric-item error" v-if="summary.failed_tasks > 0">
          <div class="metric-value">{{ summary.failed_tasks }}</div>
          <div class="metric-label">❌ 失败</div>
        </div>

        <div class="metric-item warning" v-if="summary.skipped_tasks > 0">
          <div class="metric-value">{{ summary.skipped_tasks }}</div>
          <div class="metric-label">⏭️ 跳过</div>
        </div>
      </div>

      <!-- 性能指标 -->
      <div class="performance-section">
        <div class="performance-item">
          <span class="perf-label">⏱️ 总耗时</span>
          <span class="perf-value">{{ formatTime(summary.execution_time) }}</span>
        </div>

        <div v-if="summary.parallel_efficiency" class="performance-item highlight">
          <span class="perf-label">⚡ 并行效率</span>
          <span class="perf-value">{{ summary.parallel_efficiency }}%</span>
          <span class="perf-hint">相比顺序执行节省时间</span>
        </div>

        <div class="performance-item">
          <span class="perf-label">📊 平均任务耗时</span>
          <span class="perf-value">{{ formatTime(getAverageTime()) }}</span>
        </div>
      </div>

      <!-- 成功率进度条 -->
      <div class="success-rate-section">
        <div class="rate-header">
          <span class="rate-label">成功率</span>
          <span class="rate-percentage">{{ getSuccessRate() }}%</span>
        </div>
        <div class="rate-bar">
          <div
            class="rate-fill"
            :style="{ width: getSuccessRate() + '%' }"
            :class="getRateClass()"
          ></div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  summary: {
    type: Object,
    default: null
  }
});

const formatTime = (seconds) => {
  if (!seconds) return '0s';
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(2)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(1);
  return `${minutes}m ${secs}s`;
};

const getAverageTime = () => {
  if (!props.summary || !props.summary.total_tasks) return 0;
  return props.summary.execution_time / props.summary.total_tasks;
};

const getSuccessRate = () => {
  if (!props.summary || !props.summary.total_tasks) return 0;
  return Math.round((props.summary.completed_tasks / props.summary.total_tasks) * 100);
};

const getRateClass = () => {
  const rate = getSuccessRate();
  if (rate === 100) return 'perfect';
  if (rate >= 80) return 'good';
  if (rate >= 60) return 'warning';
  return 'poor';
};
</script>

<style scoped>
.execution-summary-card {
  margin-top: var(--spacing-lg);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--glass-bg-light);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--color-border);
  animation: fadeInScale 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.summary-header {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  padding: var(--spacing-md) var(--spacing-lg);
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-weight: 600;
  border-bottom: 1px solid var(--color-border);
}

.summary-icon {
  font-size: 1.5rem;
}

.summary-title {
  font-size: 1rem;
  flex: 1;
}

.summary-badge {
  padding: 4px 12px;
  background: var(--color-interactive-subtle);
  color: var(--color-interactive-hover);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  border: 1px solid var(--color-border);
}

.summary-badge.success {
  background: var(--color-success-bg);
  color: var(--color-success);
  border-color: var(--color-success);
}

.summary-badge.failed {
  background: var(--color-error-bg);
  color: var(--color-error);
  border-color: var(--color-error);
}

.summary-content {
  padding: var(--spacing-lg);
}

/* 统计指标网格 */
.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(100px, 1fr));
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-lg);
}

.metric-item {
  background: var(--color-bg-elevated);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  text-align: center;
  border: 2px solid var(--color-border);
  transition: all 0.3s ease;
}

.metric-item:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.metric-item.success {
  border-color: var(--color-success);
  background: var(--color-success-bg);
}

.metric-item.error {
  border-color: var(--color-error);
  background: var(--color-error-bg);
}

.metric-item.warning {
  border-color: var(--color-warning);
  background: var(--color-warning-bg);
}

.metric-value {
  font-size: 2rem;
  font-weight: 700;
  color: var(--color-text-primary);
  margin-bottom: 4px;
}

.metric-label {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* 性能指标 */
.performance-section {
  background: var(--color-bg-elevated);
  padding: var(--spacing-md);
  border-radius: var(--radius-md);
  margin-bottom: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
}

.performance-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-sm);
  border-radius: var(--radius-sm);
  transition: background 0.2s ease;
}

.performance-item:hover {
  background: var(--color-bg-tertiary);
}

.performance-item.highlight {
  background: var(--color-interactive-subtle);
  border-left: 3px solid var(--color-interactive);
  padding-left: var(--spacing-md);
}

.perf-label {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  font-weight: 600;
  display: flex;
  align-items: center;
  gap: 4px;
}

.perf-value {
  font-size: 1.1rem;
  font-weight: 700;
  color: var(--color-text-primary);
}

.perf-hint {
  font-size: 0.7rem;
  color: var(--color-text-muted);
  margin-left: auto;
  padding-left: var(--spacing-sm);
}

/* 成功率 */
.success-rate-section {
  margin-top: var(--spacing-md);
}

.rate-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-sm);
}

.rate-label {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.rate-percentage {
  font-size: 1.2rem;
  font-weight: 700;
  color: var(--color-text-primary);
}

.rate-bar {
  height: 12px;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-full);
  overflow: hidden;
  position: relative;
}

.rate-fill {
  height: 100%;
  border-radius: var(--radius-full);
  transition: width 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.rate-fill::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.3), transparent);
  animation: shimmer 2s infinite;
}

.rate-fill.perfect {
  background: var(--color-success);
}

.rate-fill.good {
  background: var(--color-active);
}

.rate-fill.warning {
  background: var(--color-warning);
}

.rate-fill.poor {
  background: var(--color-error);
}

/* 动画 */
@keyframes fadeInScale {
  from {
    opacity: 0;
    transform: scale(0.95);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}
</style>
