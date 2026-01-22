<template>
  <div class="subtask-card">
    <div class="subtask-header" @click="toggleExpanded">
      <span class="icon" :class="{ expanded: subtask.expanded }">▶</span>
      <span class="subtask-title">
        <span class="subtask-number">步骤 {{ subtask.order }}</span>
        <span class="subtask-agent">{{ subtask.agent_display_name }}</span>
      </span>
      <span class="subtask-status" :class="subtask.status">
        {{ getStatusText(subtask.status) }}
      </span>
    </div>

    <div class="subtask-body" :style="contentStyle">
      <div class="subtask-slider" :style="sliderStyle">
        <!-- 详情 (Top) -->
        <div ref="detailRef" class="subtask-details" :style="{ opacity: subtask.expanded ? 1 : 0 }">
          <div class="subtask-description-full">
            <strong>任务描述：</strong>{{ subtask.description }}
          </div>

          <!-- ReAct 推理流程 -->
          <ReActStepsList
            v-if="subtask.react_steps && subtask.react_steps.length > 0"
            :steps="subtask.react_steps"
          />

          <!-- 结果摘要 -->
          <div v-if="subtask.result_summary" class="subtask-result">
            <div class="section-header">📋 完整结果</div>
            <div class="result-content-full">{{ subtask.result_summary }}</div>
          </div>
        </div>

        <!-- 预览 (Bottom) -->
        <div ref="previewRef" class="subtask-preview" :style="{ opacity: subtask.expanded ? 0 : 1 }">
          <div class="subtask-description">{{ subtask.description }}</div>
          <div v-if="subtask.result_summary" class="subtask-summary">
            {{ subtask.result_summary }}
          </div>
        </div>
      </div>
    </div>
  </div>

  <!-- 外部悬浮收起按钮 -->
  <div v-if="subtask.expanded" class="collapse-trigger-external">
    <div class="trigger-content" @click="toggleExpanded">
      <svg class="icon-up" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg">
        <path d="M533.333333 512L341.333333 704l29.866667 29.866667 162.133333-162.133334 162.133334 162.133334 29.866666-29.866667-192-192z m0-256L341.333333 448l29.866667 29.866667 162.133333-162.133334 162.133334 162.133334 29.866666-29.866667L533.333333 256z" fill="currentColor"
        stroke="currentColor"
        stroke-width="30"></path>
      </svg>
    </div>
  </div>

  <!-- 外部展开按钮（预览模式下显示） -->
  <div v-else class="expand-trigger-external">
    <div class="trigger-content" @click="toggleExpanded">
      <svg class="icon-down" viewBox="0 0 1024 1024" version="1.1" xmlns="http://www.w3.org/2000/svg">
        <path d="M533.333333 512L341.333333 704l29.866667 29.866667 162.133333-162.133334 162.133334 162.133334 29.866666-29.866667-192-192z m0-256L341.333333 448l29.866667 29.866667 162.133333-162.133334 162.133334 162.133334 29.866666-29.866667L533.333333 256z" fill="currentColor"
        stroke="currentColor"
        stroke-width="30"></path>
      </svg>
    </div>
  </div>
</template>

<script setup>
import { ref, defineProps, defineEmits, onMounted, onUnmounted, computed } from 'vue';
import ReActStepsList from './ReActStepsList.vue';

const props = defineProps({
  subtask: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['update:expanded']);

const toggleExpanded = () => {
  emit('update:expanded', !props.subtask.expanded);
};

const getStatusText = (status) => {
  const statusMap = {
    'running': '⏳ 执行中',
    'success': '✅ 完成',
    'error': '❌ 失败'
  };
  return statusMap[status] || status;
};

// Animation Logic
const detailRef = ref(null);
const previewRef = ref(null);
const detailHeight = ref(0);
const previewHeight = ref(0);
let resizeObserver;

onMounted(() => {
  resizeObserver = new ResizeObserver(entries => {
    for (const entry of entries) {
      if (entry.target === detailRef.value) {
        detailHeight.value = entry.target.offsetHeight;
      } else if (entry.target === previewRef.value) {
        previewHeight.value = entry.target.offsetHeight;
      }
    }
  });

  if (detailRef.value) resizeObserver.observe(detailRef.value);
  if (previewRef.value) resizeObserver.observe(previewRef.value);
});

onUnmounted(() => {
  if (resizeObserver) resizeObserver.disconnect();
});

const contentStyle = computed(() => {
  const height = props.subtask.expanded ? detailHeight.value : previewHeight.value;
  // Prevent zero height flash during init
  if (height === 0) return { height: 'auto' };
  return { height: `${height}px` };
});

const sliderStyle = computed(() => {
  // If expanded, translateY is 0 (show detail at top)
  // If collapsed, translateY is -detailHeight (slide up to show preview at bottom)
  const translateY = props.subtask.expanded ? 0 : -detailHeight.value;
  return { transform: `translateY(${translateY}px)` };
});
</script>

<style scoped>
/* 子任务卡片 */
.subtask-card {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--glass-bg-light);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transition: all var(--transition-normal);
  animation: fadeInUp 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--glass-shadow);
  margin-bottom: var(--spacing-sm);
  display: flex;
  flex-direction: column;
}

.subtask-card:hover {
  background: var(--color-bg-secondary);
  border-color: var(--color-border-hover);
}

.subtask-header {
  background: var(--color-bg-elevated);
  padding: var(--spacing-md) var(--spacing-lg);
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  transition: all var(--transition-fast);
  z-index: 10;
  position: relative;
}

.subtask-header:hover {
  background: var(--color-bg-tertiary);
}

.subtask-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.subtask-number {
  font-weight: 700;
  color: var(--color-text-primary);
  font-size: 0.95rem;
}

.subtask-agent {
  padding: 4px 12px;
  background: rgba(168, 85, 247, 0.15);
  color: #c084fc;
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  border: 1px solid var(--color-border);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.subtask-status {
  font-size: 0.8rem;
  font-weight: 700;
  padding: 4px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.subtask-status.running {
  background: var(--color-warning-bg);
  color: var(--color-warning);
  border-color: var(--color-warning);
}

.subtask-status.success {
  background: var(--color-success-bg);
  color: var(--color-success);
  border-color: var(--color-success);
}

.subtask-status.error {
  background: var(--color-error-bg);
  color: var(--color-error);
  border-color: var(--color-error);
}

.icon {
  font-size: 10px;
  transition: transform 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  color: var(--color-text-muted);
  display: inline-block;
}

.icon.expanded {
  transform: rotate(90deg);
}

/* 动画容器 */
.subtask-body {
  position: relative;
  overflow: hidden;
  background: var(--color-bg-primary);
  /* 使用稍慢的 duration 让动画更优雅 */
  transition: height 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: height;
}

.subtask-slider {
  display: flex;
  flex-direction: column;
  /* Transform transition matching the height transition */
  transition: transform 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  will-change: transform;
}

/* 详情 (Top) */
.subtask-details {
  padding: var(--spacing-lg);
  box-sizing: border-box;
  transition: opacity 0.5s ease;
}

.subtask-description-full {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  /* margin-bottom: var(--spacing-xl); */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

.section-header {
  font-size: 0.9rem;
  font-weight: 700;
  color: var(--color-text-primary);
  margin: var(--spacing-xl) 0 var(--spacing-md) 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 结果摘要 */
.subtask-result {
  margin-top: var(--spacing-lg);
  padding-top: var(--spacing-lg);
  border-top: 1px solid var(--color-border);
}

/* 完整结果样式 */
.result-content-full {
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  padding: var(--spacing-lg);
  background: var(--color-success-bg);
  border-left: 3px solid var(--color-success);
  border-radius: var(--radius-md);
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
  white-space: pre-wrap;
  font-family: var(--font-mono);
  max-height: 500px;
  overflow-y: auto;
}

/* 预览 (Bottom) */
.subtask-preview {
  padding: var(--spacing-lg);
  box-sizing: border-box;
  transition: opacity 0.5s ease;
}

/* 外部悬浮收起按钮 */
.collapse-trigger-external {
  margin-top: -12px;
  margin-bottom: var(--spacing-sm);
  height: 44px; /* Increased from 28px */
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  opacity: 0;
  animation: fadeIn 0.3s forwards 0.3s;
}

.trigger-content {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px; /* Increased from 24px */
  height: 40px; /* Increased from 24px */
  color: var(--color-primary); /* Changed from muted to primary for visibility */
  transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
  border-radius: 50%; /* Make it fully circular */
  /* background: var(--color-bg-primary);
  border: 1px solid var(--color-border); */
  /* box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15); */
  cursor: pointer;
}

.trigger-content:hover {
  color: var(--color-primary);
  border-color: var(--color-primary);
  transform: scale(1.15) translateY(-2px);
  /* box-shadow: 0 4px 12px rgba(129, 140, 248, 0.25); */
  /* background: var(--color-bg-elevated); */
}

.icon-up {
  width: 32px;
  height: 32px;
  animation: pulse-scale 2s infinite ease-in-out;
}

.expand-trigger-external {
  margin-top: -12px; 
  margin-bottom: var(--spacing-sm);
  height: 44px; /* Increased from 28px */
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  animation: fadeIn 0.3s forwards;
}

.icon-down {
  width: 32px;
  height: 32px;
  transform: rotate(180deg);
  animation: pulse-scale-rotate 2s infinite ease-in-out;
}

@keyframes fadeIn {
  to { opacity: 1; }
}

@keyframes pulse-scale {
  0% { transform: scale(1); }
  50% { transform: scale(1.2); }
  100% { transform: scale(1); }
}

/* Specific rotation for icon-down needs to be combined with scale */
.icon-down {
  animation: pulse-scale-rotate 2s infinite ease-in-out;
}

@keyframes pulse-scale-rotate {
  0% { transform: scale(1) rotate(180deg); }
  50% { transform: scale(1.2) rotate(180deg); }
  100% { transform: scale(1) rotate(180deg); }
}

.subtask-description {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  /* margin-bottom: var(--spacing-md); */
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

.subtask-summary {
  font-size: 0.85rem;
  color: var(--color-text-muted);
  padding-left: var(--spacing-lg);
  border-left: 3px solid var(--color-border);
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
  line-height: 1.7;
}

/* 动画 */
@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>