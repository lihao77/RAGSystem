<template>
  <div class="react-timeline">
    <div class="timeline-header">
      <span class="timeline-title">🧠 推理时间轴 ({{ steps.length }} 轮)</span>
      <span class="timeline-stats">🔧 {{ totalToolCalls }} 工具</span>
    </div>

    <div class="timeline-container">
      <!-- 垂直连接线 -->
      <div class="timeline-line"></div>

      <div v-for="(step, index) in steps" :key="index" class="timeline-item">
        <!-- 步骤标记点 -->
        <div class="timeline-marker">{{ step.round }}</div>

        <div class="timeline-content">
          <!-- 思考内容 -->
          <div class="step-thought">
            <div class="thought-bubble">{{ step.thought }}</div>
          </div>

          <!-- 工具调用列表（无嵌套框） -->
          <div v-if="step.toolCalls && step.toolCalls.length > 0" class="step-tools">
            <div v-for="(tool, toolIndex) in step.toolCalls" :key="toolIndex" class="tool-item-minimal">
              <div class="tool-header-row" @click="tool.expanded = !tool.expanded">
                <span class="tool-status-dot" :class="tool.status"></span>
                <span class="tool-name">{{ tool.tool_name }}</span>
                <span v-if="tool.elapsed_time" class="tool-time">{{ tool.elapsed_time.toFixed(2) }}s</span>
                <span class="tool-expand-icon">{{ tool.expanded ? '▼' : '▶' }}</span>
              </div>

              <!-- 展开详情（仅在点击时显示） -->
              <div v-show="tool.expanded" class="tool-details-panel">
                <!-- 参数部分 -->
                <div v-if="Object.keys(tool.arguments || {}).length > 0" class="detail-section">
                  <div class="detail-toggle" @click.stop="tool.showArgs = !tool.showArgs">
                    <span class="detail-label">参数</span>
                    <span class="detail-icon">{{ tool.showArgs ? '▼' : '▶' }}</span>
                  </div>
                  <pre v-show="tool.showArgs" class="detail-code">{{ JSON.stringify(tool.arguments, null, 2) }}</pre>
                </div>

                <!-- 结果部分 -->
                <div v-if="tool.result" class="detail-section">
                  <div class="detail-toggle" @click.stop="tool.showResult = !tool.showResult">
                    <span class="detail-label">结果</span>
                    <span class="detail-icon">{{ tool.showResult ? '▼' : '▶' }}</span>
                  </div>
                  <pre v-show="tool.showResult" class="detail-code">{{ JSON.stringify(tool.result, null, 2) }}</pre>
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
import { computed, defineProps } from 'vue';

const props = defineProps({
  steps: {
    type: Array,
    required: true
  }
});

// 初始化展开状态
props.steps.forEach(step => {
  if (step.toolCalls) {
    step.toolCalls.forEach(tool => {
      // 外层展开状态（默认不展开）
      if (tool.expanded === undefined) {
        tool.expanded = false;
      }
      // 内层详情折叠状态（默认不展开）
      if (tool.showArgs === undefined) {
        tool.showArgs = false;
      }
      if (tool.showResult === undefined) {
        tool.showResult = false;
      }
    });
  }
});

const totalToolCalls = computed(() => {
  return props.steps.reduce((sum, step) => sum + (step.toolCalls?.length || 0), 0);
});
</script>

<style scoped>
.react-timeline {
  padding: 8px 0;
}

.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--color-text-secondary);
  font-weight: 600;
}

.timeline-container {
  position: relative;
  padding-left: 16px;
}

.timeline-line {
  position: absolute;
  left: 27px;
  top: 10px;
  bottom: 0;
  width: 2px;
  background-color: var(--color-border);
  z-index: 0;
}

.timeline-item {
  position: relative;
  margin-bottom: 24px;
  display: flex;
  gap: 16px;
  z-index: 1;
}

.timeline-item:last-child {
  margin-bottom: 0;
  /* 隐藏最后一个项目的连接线延伸 */
}

.timeline-marker {
  flex-shrink: 0;
  width: 24px;
  height: 24px;
  background: var(--color-primary);
  color: white;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: bold;
  box-shadow: 0 0 0 4px white; /* 创建间隔效果 */
}

.timeline-content {
  flex: 1;
  min-width: 0;
}

.step-thought {
  margin-bottom: 8px;
}

.thought-bubble {
  background: var(--color-bg-app);
  padding: 10px 14px;
  border-radius: 8px 8px 8px 0;
  color: var(--color-text-secondary);
  font-size: 13px;
  line-height: 1.5;
  border: 1px solid var(--color-border);
}

.step-tools {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.tool-item-minimal {
  background: white;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  overflow: hidden;
  transition: all 0.2s ease;
}

.tool-item-minimal:hover {
  border-color: var(--color-border-hover);
  box-shadow: var(--shadow-sm);
}

.tool-header-row {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  cursor: pointer;
  gap: 10px;
  background: white;
}

.tool-header-row:hover {
  background: var(--color-bg-app);
}

.tool-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ccc;
}

.tool-status-dot.success { background: var(--color-success); }
.tool-status-dot.error { background: var(--color-error); }
.tool-status-dot.running {
  background: var(--color-warning);
  animation: pulse 1.5s infinite;
}

.tool-name {
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
  flex: 1;
}

.tool-time {
  font-size: 11px;
  color: var(--color-text-muted);
}

.tool-expand-icon {
  font-size: 10px;
  color: var(--color-text-muted);
}
.tool-details-panel {
  padding: 0 12px 12px 12px;
  background: var(--color-bg-app);
  border-top: 1px solid var(--color-border);
}

.detail-section {
  margin-top: 8px;
}

.detail-toggle {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  background: white;
  border: 1px solid var(--color-border);
  border-radius: 4px;
  cursor: pointer;
  user-select: none;
  transition: background 0.2s ease;
  margin-bottom: 4px;
}

.detail-toggle:hover {
  background: var(--color-bg-app);
}

.detail-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.detail-icon {
  font-size: 10px;
  color: var(--color-text-muted);
}

.detail-code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: white;
  padding: 8px;
  border-radius: 4px;
  border: 1px solid var(--color-border);
  overflow-x: auto;
  margin: 0;
  color: var(--color-text-secondary);
  max-height: 300px;
  overflow-y: auto;
}

@keyframes pulse {
  0% { opacity: 0.5; }
  50% { opacity: 1; }
  100% { opacity: 0.5; }
}
</style>