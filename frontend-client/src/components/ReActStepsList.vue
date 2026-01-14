<template>
  <div class="react-timeline">
    <div class="timeline-header">
      <span class="timeline-title">
        <span class="pulse-icon">🧠</span>
        <span>推理过程</span>
        <span class="step-badge">{{ steps.length }} 轮</span>
      </span>
      <span class="timeline-stats">
        <span class="stat-icon">🔧</span> {{ totalToolCalls }} 工具调用
      </span>
    </div>

    <div class="timeline-container">
      <!-- 动态连接线 -->
      <div class="timeline-line-track">
        <div class="timeline-line-progress"></div>
      </div>

      <div
        v-for="(step, index) in steps"
        :key="index"
        class="timeline-item"
        :style="{ '--delay': `${index * 0.1}s` }"
      >
        <!-- 步骤标记点 -->
        <div class="timeline-marker-wrapper">
          <div class="timeline-marker">
            <span class="marker-text">{{ step.round }}</span>
            <div class="marker-glow"></div>
          </div>
        </div>

        <div class="timeline-content">
          <!-- 思考内容 -->
          <div class="step-thought glass-card">
            <div class="thought-icon">💭</div>
            <div class="thought-text">{{ step.thought }}</div>
          </div>

          <!-- 工具调用列表 -->
          <div v-if="step.toolCalls && step.toolCalls.length > 0" class="step-tools">
            <div
              v-for="(tool, toolIndex) in step.toolCalls"
              :key="toolIndex"
              class="tool-item glass-chip"
              :class="tool.status"
            >
              <div class="tool-header" @click="tool.expanded = !tool.expanded">
                <div class="tool-status-indicator">
                  <div class="status-dot"></div>
                  <div class="status-ring"></div>
                </div>

                <span class="tool-name">{{ tool.tool_name }}</span>

                <div class="tool-meta">
                  <span v-if="tool.elapsed_time" class="tool-time">
                    {{ tool.elapsed_time.toFixed(2) }}s
                  </span>
                  <span class="tool-expand-btn" :class="{ rotated: tool.expanded }">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="6 9 12 15 18 9"></polyline>
                    </svg>
                  </span>
                </div>
              </div>

              <!-- 展开详情 -->
              <transition name="slide-fade">
                <div v-show="tool.expanded" class="tool-details">
                  <!-- 参数 -->
                  <div v-if="Object.keys(tool.arguments || {}).length > 0" class="detail-block">
                    <div class="detail-header" @click.stop="tool.showArgs = !tool.showArgs">
                      <span>输入参数</span>
                      <span class="code-tag">JSON</span>
                    </div>
                    <div class="code-wrapper">
                      <pre class="detail-code">{{ JSON.stringify(tool.arguments, null, 2) }}</pre>
                    </div>
                  </div>

                  <!-- 结果 -->
                  <div v-if="tool.result" class="detail-block">
                    <div class="detail-header" @click.stop="tool.showResult = !tool.showResult">
                      <span>执行结果</span>
                      <span class="code-tag result-tag">RESULT</span>
                    </div>
                    <div class="code-wrapper">
                      <pre class="detail-code result-code">{{ JSON.stringify(tool.result, null, 2) }}</pre>
                    </div>
                  </div>
                </div>
              </transition>
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
      if (tool.expanded === undefined) tool.expanded = false;
      if (tool.showArgs === undefined) tool.showArgs = true;
      if (tool.showResult === undefined) tool.showResult = true;
    });
  }
});

const totalToolCalls = computed(() => {
  return props.steps.reduce((sum, step) => sum + (step.toolCalls?.length || 0), 0);
});
</script>

<style scoped>
/* Glass Morphism Variables */
:root {
  --glass-border: 1px solid rgba(255, 255, 255, 0.4);
  --glass-bg: rgba(255, 255, 255, 0.45);
  --glass-shadow: 0 8px 32px 0 rgba(31, 38, 135, 0.07);
  --primary-gradient: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
  --success-gradient: linear-gradient(135deg, #10b981 0%, #34d399 100%);
  --error-gradient: linear-gradient(135deg, #ef4444 0%, #f87171 100%);
  --warning-gradient: linear-gradient(135deg, #f59e0b 0%, #fbbf24 100%);
}

.react-timeline {
  padding: 12px 4px;
  font-family: var(--font-sans);
}

/* Header Styles */
.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 24px;
  padding: 0 4px;
}

.timeline-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 700;
  color: var(--color-text-main);
  letter-spacing: -0.01em;
}

.pulse-icon {
  font-size: 16px;
  animation: float 3s ease-in-out infinite;
}

.step-badge {
  background: rgba(99, 102, 241, 0.1);
  color: var(--color-primary);
  padding: 2px 8px;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid rgba(99, 102, 241, 0.2);
}

.timeline-stats {
  font-size: 12px;
  color: var(--color-text-secondary);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
  background: rgba(255, 255, 255, 0.3);
  padding: 4px 10px;
  border-radius: 20px;
  border: 1px solid rgba(255, 255, 255, 0.4);
}

/* Timeline Track */
.timeline-container {
  position: relative;
  padding-left: 28px;
}

.timeline-line-track {
  position: absolute;
  left: 11px;
  top: 12px;
  bottom: 24px;
  width: 2px;
  background: rgba(99, 102, 241, 0.1);
  border-radius: 2px;
  overflow: hidden;
}

.timeline-line-progress {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 60%;
  background: linear-gradient(to bottom,
    var(--color-primary) 0%,
    rgba(139, 92, 246, 0.5) 50%,
    transparent 100%
  );
  filter: blur(1px);
  animation: flow 3s infinite linear;
}

/* Timeline Item */
.timeline-item {
  position: relative;
  margin-bottom: 28px;
  animation: slideIn 0.5s ease-out backwards;
  animation-delay: var(--delay);
}

.timeline-item:last-child {
  margin-bottom: 0;
}

/* Marker */
.timeline-marker-wrapper {
  position: absolute;
  left: -28px;
  top: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2;
}

.timeline-marker {
  width: 20px;
  height: 20px;
  background: var(--primary-gradient);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 3px rgba(255, 255, 255, 0.8), 0 4px 10px rgba(99, 102, 241, 0.3);
  position: relative;
}

.marker-text {
  color: white;
  font-size: 10px;
  font-weight: 700;
  z-index: 2;
}

.marker-glow {
  position: absolute;
  top: -2px;
  left: -2px;
  right: -2px;
  bottom: -2px;
  border-radius: 50%;
  background: var(--color-primary);
  opacity: 0.4;
  filter: blur(4px);
  animation: pulse-glow 2s infinite;
  z-index: 1;
}

/* Thought Bubble */
.step-thought {
  display: flex;
  gap: 12px;
  padding: 14px 16px;
  margin-bottom: 12px;
  position: relative;
}

.glass-card {
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.5);
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.03);
  border-radius: 16px;
  border-top-left-radius: 4px;
}

.thought-icon {
  font-size: 16px;
  opacity: 0.8;
  padding-top: 2px;
}

.thought-text {
  font-size: 13px;
  line-height: 1.6;
  color: var(--color-text-main);
  font-weight: 500;
}

/* Tool Items */
.step-tools {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-left: 8px;
}

.glass-chip {
  background: rgba(255, 255, 255, 0.4);
  backdrop-filter: blur(8px);
  border: 1px solid rgba(255, 255, 255, 0.3);
  border-radius: 12px;
  overflow: hidden;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

/* .glass-chip:hover {
  background: rgba(255, 255, 255, 0.7);
  transform: translateY(-2px) translateX(2px);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.06);
  border-color: rgba(255, 255, 255, 0.8);
} */

.tool-header {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  cursor: pointer;
  gap: 12px;
}

/* Status Indicators */
.tool-status-indicator {
  position: relative;
  width: 10px;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #ccc;
  z-index: 2;
}

.status-ring {
  position: absolute;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  border: 1.5px solid transparent;
  opacity: 0.5;
}

/* Status Colors */
.success .status-dot { background: #10b981; }
.success .status-ring { border-color: #10b981; }

.error .status-dot { background: #ef4444; }
.error .status-ring { border-color: #ef4444; }

.running .status-dot { background: #f59e0b; }
.running .status-ring {
  border-color: #f59e0b;
  border-top-color: transparent;
  animation: spin 1s linear infinite;
}

.tool-name {
  flex: 1;
  /* font-family: 'JetBrains Mono', monospace; */
  font-size: 12px;
  font-weight: 600;
  color: var(--color-text-main);
  letter-spacing: -0.02em;
}

.tool-meta {
  display: flex;
  align-items: center;
  gap: 10px;
}

.tool-time {
  font-size: 10px;
  font-weight: 600;
  color: var(--color-text-muted);
  background: rgba(0, 0, 0, 0.03);
  padding: 2px 6px;
  border-radius: 4px;
}

.tool-expand-btn {
  color: var(--color-text-muted);
  transition: transform 0.3s ease;
  display: flex;
  align-items: center;
}

.tool-expand-btn.rotated {
  transform: rotate(180deg);
}

/* Details Panel */
.tool-details {
  border-top: 1px solid rgba(0, 0, 0, 0.03);
  background: rgba(255, 255, 255, 0.2);
}

.detail-block {
  padding: 0;
}

.detail-header {
  padding: 8px 14px;
  font-size: 11px;
  font-weight: 600;
  color: var(--color-text-secondary);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  background: rgba(255, 255, 255, 0.1);
  transition: background 0.2s;
}

.detail-header:hover {
  background: rgba(255, 255, 255, 0.3);
}

.code-tag {
  font-size: 9px;
  padding: 2px 6px;
  background: rgba(99, 102, 241, 0.1);
  color: var(--color-primary);
  border-radius: 4px;
  font-weight: 700;
}

.result-tag {
  background: rgba(16, 185, 129, 0.1);
  color: #059669;
}

.code-wrapper {
  padding: 10px 14px;
  background: rgba(250, 250, 255, 0.5);
}

.detail-code {
  margin: 0;
  /* font-family: 'JetBrains Mono', monospace; */
  font-size: 11px;
  line-height: 1.5;
  color: #334155;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 300px;
  overflow-y: auto;
}

.result-code {
  color: #0f172a;
}

/* Animations */
@keyframes float {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-3px); }
}

@keyframes pulse-glow {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 0.2; transform: scale(1.5); }
}

@keyframes flow {
  0% { transform: translateY(-100%); }
  100% { transform: translateY(100%); }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@keyframes slideIn {
  from { opacity: 0; transform: translateY(10px); }
  to { opacity: 1; transform: translateY(0); }
}

.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all 0.3s ease-out;
  max-height: 500px;
  opacity: 1;
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
}
</style>