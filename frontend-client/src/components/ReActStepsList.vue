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

      <div v-for="(step, index) in steps" :key="index" class="timeline-item" :style="{ '--delay': `${index * 0.1}s` }">
        <!-- 步骤标记点 -->
        <div class="timeline-marker-wrapper">
          <div class="timeline-marker">
            <span class="marker-text">{{ step.round }}</span>
            <div class="marker-glow"></div>
          </div>
        </div>

        <div class="timeline-content">
          <!-- 思考内容 -->
          <div class="step-thought" :class="{ running: isStepRunning(step) }">
            <!-- <div class="thought-icon">💭</div> -->
            <div class="thought-text">{{ step.thought }}</div>
          </div>

          <!-- 工具调用列表 -->
          <div v-if="step.toolCalls && step.toolCalls.length > 0" class="step-tools">
            <!-- <div v-for="(tool, toolIndex) in step.toolCalls" :key="toolIndex" class="tool-item" :class="tool.status" :class="{'expanded': tool.expanded"> -->
            <div v-for="(tool, toolIndex) in step.toolCalls" :key="toolIndex" class="tool-item"
              :class="[tool.status, { expanded: tool.expanded }]">
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

// Check if a step is currently running (has any running tool)
const isStepRunning = (step) => {
  return step.toolCalls?.some(tool => tool.status === 'running') || false;
};
</script>

<style scoped>
.react-timeline {
  padding: var(--spacing-lg) 0;
  font-family: var(--font-sans);
}

/* Header Styles */
.timeline-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--spacing-xl);
  padding: 0 var(--spacing-xs);
}

.timeline-title {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
}

.pulse-icon {
  font-size: 1.1rem;
  opacity: 0.9;
}

.step-badge {
  background: var(--color-interactive-subtle);
  color: var(--color-text-secondary);
  padding: 3px 10px;
  border-radius: var(--radius-full);
  font-size: 0.7rem;
  font-weight: 700;
  border: 1px solid var(--color-glass-border);
  letter-spacing: 0.03em;
}

.timeline-stats {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  font-weight: 500;
  display: flex;
  align-items: center;
  gap: 6px;
}

/* Timeline Container - No left border */
.timeline-container {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xl);
}

.timeline-line-track {
  display: none;
}

/* Timeline Item */
.timeline-item {
  position: relative;
  animation: slideIn 0.5s ease-out backwards;
  animation-delay: var(--delay);
}

.timeline-marker-wrapper {
  display: none;
}

.timeline-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

/* Thought Block - Flat, Lighter Background, No Shadow */
.step-thought {
  display: flex;
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-lg);
  border-left: 3px solid var(--color-success);
  transition: all var(--transition-fast);
}

.step-thought.running {
  background: var(--color-bg-tertiary);
  border-left-color: var(--color-warning);
  box-shadow: -2px 0 20px var(--color-interactive-glow);
}

.thought-icon {
  font-size: 1.2rem;
  opacity: 0.7;
  flex-shrink: 0;
}

.thought-text {
  font-size: 0.9rem;
  line-height: 1.8;
  color: var(--color-text-primary);
  font-weight: 400;
}

/* Tool Items - Darker Flat Blocks, More Indented */
.step-tools {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-sm);
  margin-left: var(--spacing-xl);
  padding-left: var(--spacing-md);
  border-left: 2px solid var(--color-border);
}

.tool-item {
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  /* border: 1px solid var(--color-border); */
  overflow: visible;
  transition: all var(--transition-fast);
}

.tool-item.running {
  border-color: var(--color-warning);
  box-shadow: 0 0 0 1px var(--color-warning);
}

.tool-item.expanded {
  background: var(--color-bg-primary);
}

.tool-header {
  display: flex;
  align-items: center;
  padding: var(--spacing-md);
  cursor: pointer;
  gap: var(--spacing-md);
}

/* Status Indicators */
.tool-status-indicator {
  position: relative;
  width: 10px;
  height: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-muted);
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
.success .status-dot {
  background: var(--color-success);
}

.success .status-ring {
  border-color: var(--color-success);
}

.error .status-dot {
  background: var(--color-error);
}

.error .status-ring {
  border-color: var(--color-error);
}

.running .status-dot {
  background: var(--color-warning);
}

.running .status-ring {
  border-color: var(--color-warning);
  border-top-color: transparent;
  animation: spin 1s linear infinite;
}

.tool-name {
  flex: 1;
  min-width: 0;
  /* 🔴 关键：覆盖默认的 min-width: auto */
  font-family: var(--font-mono);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.02em;
  white-space: nowrap !important;
  /* 禁止换行（必须） */
  overflow: hidden !important;
  /* 隐藏溢出（必须） */
  text-overflow: ellipsis !important;
  /* 显示省略号（必须） */
}

.tool-meta {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.tool-time {
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--color-text-muted);
  background: var(--color-bg-elevated);
  padding: 3px 8px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
}

.tool-expand-btn {
  color: var(--color-text-muted);
  transition: transform var(--transition-normal);
  display: flex;
  align-items: center;
}

.tool-expand-btn.rotated {
  transform: rotate(180deg);
}

/* Details Panel - Darker Background */
.tool-details {
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-app);
  border-radius: 0 0 var(--radius-md) var(--radius-md);
}

.detail-block {
  padding: 0;
}

.detail-header {
  padding: var(--spacing-sm) var(--spacing-md);
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--color-text-secondary);
  display: flex;
  justify-content: space-between;
  align-items: center;
  cursor: pointer;
  background: var(--color-bg-app);
  transition: background var(--transition-fast);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.code-tag {
  font-size: 0.65rem;
  padding: 2px 6px;
  background: var(--color-interactive-subtle);
  color: var(--color-text-secondary);
  border-radius: var(--radius-sm);
  font-weight: 700;
  letter-spacing: 0.05em;
}

.result-tag {
  background: var(--color-success-bg);
  color: var(--color-success);
}

.code-wrapper {
  padding: var(--spacing-md);
  background: var(--color-bg-app);
  border-radius: var(--radius-lg);
}

.detail-code {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 0.8rem;
  line-height: 1.7;
  color: var(--color-text-secondary);
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 400px;
  overflow-y: auto;
}

.result-code {
  color: var(--color-text-primary);
}

/* Animations */
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

@keyframes slideIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }

  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.slide-fade-enter-active,
.slide-fade-leave-active {
  transition: all var(--transition-normal);
  max-height: 600px;
  opacity: 1;
}

.slide-fade-enter-from,
.slide-fade-leave-to {
  max-height: 0;
  opacity: 0;
  overflow: hidden;
}
</style>