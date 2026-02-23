<template>
  <div class="agent-monitor">
    <div class="monitor-header">
      <div class="header-left">
        <button class="btn-back" @click="navigateToChat">
          <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="19" y1="12" x2="5" y2="12"></line>
            <polyline points="12 19 5 12 12 5"></polyline>
          </svg>
          返回聊天
        </button>
        <h1 class="monitor-title">智能体性能监控</h1>
      </div>
      <div class="monitor-actions">
        <select v-model="selectedAgent" class="agent-selector" @change="loadMetrics">
          <option value="">全部智能体</option>
          <option v-for="agent in agentList" :key="agent" :value="agent">
            {{ agent }}
          </option>
        </select>
        <button class="btn-refresh" @click="loadMetrics" :disabled="loading">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="23 4 23 10 17 10"></polyline>
            <polyline points="1 20 1 14 7 14"></polyline>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
          刷新
        </button>
        <button class="btn-reset" @click="confirmReset">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
          重置指标
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading-state">
      <div class="spinner"></div>
      <p>加载中...</p>
    </div>

    <div v-else-if="error" class="error-state">
      <p>{{ error }}</p>
      <button class="btn-retry" @click="loadMetrics">重试</button>
    </div>

    <div v-else class="monitor-content">
      <!-- 系统级指标卡片 -->
      <div v-if="!selectedAgent && systemMetrics" class="metrics-grid">
        <div class="metric-card">
          <div class="metric-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
              <circle cx="9" cy="7" r="4"></circle>
              <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
              <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
            </svg>
          </div>
          <div class="metric-content">
            <div class="metric-label">智能体总数</div>
            <div class="metric-value">{{ systemMetrics.total_agents }}</div>
          </div>
        </div>

        <div class="metric-card">
          <div class="metric-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
            </svg>
          </div>
          <div class="metric-content">
            <div class="metric-label">总调用次数</div>
            <div class="metric-value">{{ systemMetrics.total_calls }}</div>
          </div>
        </div>

        <div class="metric-card">
          <div class="metric-icon">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="22 7 13.5 15.5 8.5 10.5 2 17"></polyline>
              <polyline points="16 7 22 7 22 13"></polyline>
            </svg>
          </div>
          <div class="metric-content">
            <div class="metric-label">平均耗时</div>
            <div class="metric-value">{{ formatDuration(systemMetrics.avg_duration_ms) }}</div>
          </div>
        </div>

        <div class="metric-card">
          <div class="metric-icon success">
            <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
          </div>
          <div class="metric-content">
            <div class="metric-label">总体成功率</div>
            <div class="metric-value">{{ formatPercent(systemMetrics.overall_success_rate) }}</div>
          </div>
        </div>
      </div>

      <!-- 智能体列表 -->
      <div class="agents-section">
        <h2 class="section-title">智能体详情</h2>
        <div v-if="agentMetrics.length === 0" class="empty-state">
          <p>暂无性能数据</p>
        </div>
        <div v-else class="agents-list">
          <div v-for="agent in agentMetrics" :key="agent.agent_name" class="agent-card">
            <div class="agent-header">
              <h3 class="agent-name">{{ agent.agent_name }}</h3>
              <div class="agent-stats">
                <span class="stat-badge success">
                  成功率: {{ formatPercent(agent.success_rate) }}
                </span>
                <span class="stat-badge">
                  调用: {{ agent.total_calls }}次
                </span>
              </div>
            </div>

            <div class="agent-metrics">
              <div class="metric-row">
                <span class="metric-label">平均耗时:</span>
                <span class="metric-value">{{ formatDuration(agent.avg_duration_ms) }}</span>
              </div>
              <div class="metric-row">
                <span class="metric-label">成功/失败:</span>
                <span class="metric-value">{{ agent.success_count }} / {{ agent.failure_count }}</span>
              </div>
              <div v-if="agent.avg_tokens > 0" class="metric-row">
                <span class="metric-label">平均Token:</span>
                <span class="metric-value">{{ Math.round(agent.avg_tokens) }}</span>
              </div>
              <div v-if="agent.first_call" class="metric-row">
                <span class="metric-label">首次调用:</span>
                <span class="metric-value">{{ formatTime(agent.first_call) }}</span>
              </div>
              <div v-if="agent.last_call" class="metric-row">
                <span class="metric-label">最近调用:</span>
                <span class="metric-value">{{ formatTime(agent.last_call) }}</span>
              </div>
            </div>

            <!-- 工具使用统计 -->
            <div v-if="Object.keys(agent.tool_usage || {}).length > 0" class="tool-usage">
              <h4 class="subsection-title">工具使用统计</h4>
              <div class="tool-list">
                <div v-for="(count, tool) in agent.tool_usage" :key="tool" class="tool-item">
                  <span class="tool-name">{{ tool }}</span>
                  <span class="tool-count">{{ count }}次</span>
                  <div class="tool-bar">
                    <div class="tool-bar-fill" :style="{ width: getToolPercentage(count, agent.tool_usage) + '%' }"></div>
                  </div>
                </div>
              </div>
            </div>

            <!-- 错误分布 -->
            <div v-if="Object.keys(agent.error_distribution || {}).length > 0" class="error-distribution">
              <h4 class="subsection-title">错误分布</h4>
              <div class="error-list">
                <div v-for="(count, errorType) in agent.error_distribution" :key="errorType" class="error-item">
                  <span class="error-type">{{ errorType }}</span>
                  <span class="error-count">{{ count }}次</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, computed } from 'vue';
import { getMetrics, resetMetrics } from '../api/monitoring';

const loading = ref(false);
const error = ref('');
const selectedAgent = ref('');
const metricsData = ref(null);

const systemMetrics = computed(() => {
  if (!metricsData.value) return null;
  return metricsData.value.system_metrics || metricsData.value;
});

const agentMetrics = computed(() => {
  if (!metricsData.value) return [];

  if (selectedAgent.value) {
    // 单个智能体
    const agent = metricsData.value.agent_metrics || metricsData.value;
    return agent ? [agent] : [];
  } else {
    // 所有智能体
    const agents = metricsData.value.agents || {};
    return Object.values(agents);
  }
});

const agentList = computed(() => {
  if (!metricsData.value) return [];
  const agents = metricsData.value.agents || {};
  return Object.keys(agents);
});

const loadMetrics = async () => {
  loading.value = true;
  error.value = '';

  try {
    const data = await getMetrics(selectedAgent.value || null);
    metricsData.value = data;
  } catch (err) {
    error.value = err.message || '加载指标失败';
  } finally {
    loading.value = false;
  }
};

const confirmReset = () => {
  if (confirm(`确定要重置${selectedAgent.value ? `智能体 ${selectedAgent.value} 的` : '所有'}性能指标吗？`)) {
    handleReset();
  }
};

const handleReset = async () => {
  try {
    await resetMetrics(selectedAgent.value || null);
    await loadMetrics();
  } catch (err) {
    error.value = err.message || '重置指标失败';
  }
};

const formatDuration = (ms) => {
  if (!ms) return '0ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

const formatPercent = (value) => {
  if (value == null) return '0%';
  return `${(value * 100).toFixed(1)}%`;
};

const formatTime = (timeStr) => {
  if (!timeStr) return '-';
  const date = new Date(timeStr);
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
};

const getToolPercentage = (count, toolUsage) => {
  const total = Object.values(toolUsage).reduce((sum, c) => sum + c, 0);
  return total > 0 ? (count / total) * 100 : 0;
};

const navigateToChat = () => {
  window.history.pushState({}, '', '/');
  window.location.href = '/';
};

onMounted(() => {
  loadMetrics();
});
</script>

<style scoped>
.agent-monitor {
  min-height: 100vh;
  background: var(--color-bg-primary);
  padding: var(--spacing-xl);
}

.monitor-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-xl);
  flex-wrap: wrap;
  gap: var(--spacing-md);
}

.header-left {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.btn-back {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 10px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn-back:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-text-secondary);
}

.monitor-title {
  font-size: 2rem;
  font-weight: 700;
  color: var(--color-text-primary);
  margin: 0;
}

.monitor-actions {
  display: flex;
  gap: var(--spacing-sm);
  align-items: center;
}

.agent-selector {
  padding: 10px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: 0.875rem;
  cursor: pointer;
  outline: none;
  transition: all var(--transition-fast);
}

.agent-selector:hover {
  border-color: var(--color-text-secondary);
}

.btn-refresh,
.btn-reset {
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  padding: 10px 16px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.btn-refresh:hover,
.btn-reset:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-text-secondary);
}

.btn-refresh:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--spacing-xxl);
  color: var(--color-text-secondary);
}

.spinner {
  width: 40px;
  height: 40px;
  border: 3px solid var(--color-border);
  border-top-color: var(--color-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.btn-retry {
  margin-top: var(--spacing-md);
  padding: 10px 20px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  cursor: pointer;
}

.metrics-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: var(--spacing-md);
  margin-bottom: var(--spacing-xl);
}

.metric-card {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  transition: all var(--transition-fast);
}

.metric-card:hover {
  border-color: var(--color-primary);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.1);
}

.metric-icon {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  background: var(--color-primary);
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  flex-shrink: 0;
}

.metric-icon.success {
  background: var(--color-success);
}

.metric-content {
  flex: 1;
}

.metric-label {
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  margin-bottom: 4px;
}

.metric-value {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--color-text-primary);
}

.agents-section {
  margin-top: var(--spacing-xl);
}

.section-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-lg);
}

.empty-state {
  text-align: center;
  padding: var(--spacing-xxl);
  color: var(--color-text-secondary);
}

.agents-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-lg);
}

.agent-card {
  padding: var(--spacing-lg);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}

.agent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-md);
  flex-wrap: wrap;
  gap: var(--spacing-sm);
}

.agent-name {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: 0;
  font-family: 'Courier New', monospace;
}

.agent-stats {
  display: flex;
  gap: var(--spacing-xs);
}

.stat-badge {
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  font-weight: 500;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.stat-badge.success {
  background: rgba(34, 197, 94, 0.1);
  color: var(--color-success);
}

.agent-metrics {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-md);
}

.metric-row {
  display: flex;
  justify-content: space-between;
  padding: var(--spacing-xs) 0;
  font-size: 0.875rem;
}

.metric-row .metric-label {
  color: var(--color-text-secondary);
}

.metric-row .metric-value {
  color: var(--color-text-primary);
  font-weight: 500;
}

.subsection-title {
  font-size: 1rem;
  font-weight: 600;
  color: var(--color-text-primary);
  margin: var(--spacing-md) 0 var(--spacing-sm);
}

.tool-list,
.error-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.tool-item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: var(--spacing-sm);
  align-items: center;
  padding: var(--spacing-xs);
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
}

.tool-name {
  color: var(--color-text-primary);
  font-family: 'Courier New', monospace;
  grid-column: 1;
}

.tool-count {
  color: var(--color-text-secondary);
  grid-column: 2;
}

.tool-bar {
  grid-column: 1 / -1;
  height: 4px;
  background: var(--color-bg-primary);
  border-radius: 2px;
  overflow: hidden;
}

.tool-bar-fill {
  height: 100%;
  background: var(--color-primary);
  transition: width 0.3s ease;
}

.error-item {
  display: flex;
  justify-content: space-between;
  padding: var(--spacing-xs) var(--spacing-sm);
  background: rgba(239, 68, 68, 0.1);
  border-left: 3px solid var(--color-error);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
}

.error-type {
  color: var(--color-error);
  font-weight: 500;
}

.error-count {
  color: var(--color-text-secondary);
}

@media (max-width: 767px) {
  .agent-monitor {
    padding: var(--spacing-md);
  }

  .monitor-header {
    flex-direction: column;
    align-items: stretch;
  }

  .monitor-actions {
    flex-direction: column;
  }

  .agent-selector,
  .btn-refresh,
  .btn-reset {
    width: 100%;
    justify-content: center;
  }

  .metrics-grid {
    grid-template-columns: 1fr;
  }

  .agent-header {
    flex-direction: column;
    align-items: flex-start;
  }

  .agent-metrics {
    grid-template-columns: 1fr;
  }
}
</style>
