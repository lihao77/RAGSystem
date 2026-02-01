<template>
  <div class="subtask-status-ticker glass-card" :class="{ 'is-expanded': expanded }">
    <div class="ticker-content">
      <!-- 动态滚动区域 -->
      <div class="ticker-scroll-area">
        <transition-group name="ticker-item">
           <!-- 当前正在执行的任务/工具 -->
           <div v-if="currentActivity" key="current" class="ticker-item active">
             <span class="agent-badge">{{ currentActivity.agent_display_name }}</span>
             <span class="action-text">
               <span v-if="currentActivity.tool_name" class="tool-name">🛠️ {{ currentActivity.tool_name }}</span>
               <span v-else>{{ currentActivity.description }}</span>
             </span>
             <div class="loading-dots">
               <span>.</span><span>.</span><span>.</span>
             </div>
           </div>

           <!-- 最近完成的任务 (只显示最新的一个作为历史参考) -->
           <div v-else-if="lastCompletedTask" key="last" class="ticker-item completed">
             <span class="agent-badge success">✓ {{ lastCompletedTask.agent_display_name }}</span>
             <span class="action-text">任务已完成</span>
           </div>

           <!-- 初始状态 -->
           <div v-else key="idle" class="ticker-item idle">
             <span class="action-text">等待任务开始...</span>
           </div>
        </transition-group>
      </div>

      <!-- 切换详情按钮 -->
      <button class="toggle-details-btn btn" @click="$emit('toggle-view')" :title="expanded ? '收起详情' : '显示详细执行过程'">
        <!-- <span class="icon">{{ expanded ? '🔼' : '👁️' }}</span> -->
        <span class="label">{{ expanded ? '收起' : '查看详情' }}</span>
      </button>
    </div>

    <!-- 进度条 -->
    <!-- <div class="progress-bar-container" v-if="totalTasks > 0">
      <div class="progress-bar" :style="{ width: `${progressPercentage}%` }"></div>
    </div> -->
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  subtasks: {
    type: Array,
    required: true
  },
  expanded: {
    type: Boolean,
    default: false
  }
});

defineEmits(['toggle-view']);

// 计算当前正在进行的活动
const currentActivity = computed(() => {
  // 找正在运行的子任务
  const runningTask = props.subtasks.find(t => t.status === 'running');
  if (!runningTask) return null;

  // 检查该任务是否有正在运行的工具调用
  // 需要深入 react_steps 查找
  let runningTool = null;
  if (runningTask.react_steps) {
      for (const step of runningTask.react_steps) {
          if (step.toolCalls) {
              const activeTool = step.toolCalls.find(t => t.status === 'running');
              if (activeTool) {
                  runningTool = activeTool;
                  break;
              }
          }
      }
  }

  return {
    agent_display_name: runningTask.agent_display_name,
    description: runningTask.description,
    tool_name: runningTool ? runningTool.tool_name : null
  };
});

// 最近完成的任务
const lastCompletedTask = computed(() => {
    // 找最后一个完成的任务
    const completedTasks = props.subtasks.filter(t => t.status === 'success' || t.status === 'error');
    if (completedTasks.length > 0) {
        return completedTasks[completedTasks.length - 1];
    }
    return null;
});

const totalTasks = computed(() => props.subtasks.length);
const completedCount = computed(() => props.subtasks.filter(t => t.status === 'success').length);

const progressPercentage = computed(() => {
    if (totalTasks.value === 0) return 0;
    // 如果最后一个正在运行，进度算一半
    const running = props.subtasks.find(t => t.status === 'running');
    const base = (completedCount.value / totalTasks.value) * 100;
    const extra = running ? (1 / totalTasks.value) * 50 : 0;
    return Math.min(100, base + extra);
});

</script>

<style scoped>
.subtask-status-ticker {
  border-radius: 24px; /* Use px value for interpolation */
  overflow: hidden;
  /* margin: var(--spacing-sm) 0; */
  /* box-shadow: var(--shadow-sm); */
  /* 增加 transition-property 和 duration 以匹配展开动画 */
  transition: border-radius 0.35s cubic-bezier(0.4, 0, 0.2, 1),
              background var(--transition-normal),
              border-color var(--transition-normal),
              box-shadow var(--transition-normal),
              margin 0.35s cubic-bezier(0.4, 0, 0.2, 1) !important;
  position: relative;
  z-index: 2; /* Ensure it stays on top */
}

.subtask-status-ticker.is-expanded {
  border-radius: var(--radius-lg) var(--radius-lg) 0 0; /* 上方圆角，下方直角 */
  /* border-bottom: 1px solid rgba(255, 255, 255, 0.05); */
  /* margin-bottom: 0; */
  background: var(--color-bg-elevated); /* 保持一致的背景 */
  box-shadow: none; /* 移除阴影，让整体容器统一投影 */
  /* position: sticky;
  top: calc(-1 * var(--radius-lg));
  z-index: 3; */
}

.ticker-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 16px;
  height: 48px;
}

.ticker-scroll-area {
  flex: 1;
  overflow: hidden;
  position: relative;
  height: 100%;
  display: flex;
  align-items: center;
}

.ticker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  white-space: nowrap;
  width: 100%;
}

.agent-badge {
  font-size: 0.75rem;
  padding: 2px 8px;
  background: var(--color-active-bg);
  color: var(--color-active);
  border-radius: 4px;
  font-weight: 600;
  border: 1px solid rgba(var(--color-brand-accent-light-rgb), 0.2);
}

.agent-badge.success {
    background: var(--color-success-bg);
    color: var(--color-success);
    border-color: rgba(52, 211, 153, 0.2);
}

.action-text {
  font-size: 0.9rem;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-name {
    color: var(--color-warning);
    font-family: var(--font-mono);
    font-size: 0.85rem;
}

.loading-dots {
  display: flex;
  gap: 2px;
}

.loading-dots span {
  animation: dotFade 1.4s infinite ease-in-out both;
  color: var(--color-text-muted);
}

.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
.loading-dots span:nth-child(2) { animation-delay: -0.16s; }

@keyframes dotFade {
  0%, 80%, 100% { opacity: 0; }
  40% { opacity: 1; }
}

.toggle-details-btn {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  color: var(--color-text-secondary);
  border-radius: var(--radius-full);
  padding: 4px 12px;
  font-size: 0.8rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 6px;
  transition: all var(--transition-fast);
  margin-left: 12px;
  flex-shrink: 0;
}

.toggle-details-btn:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border-color: var(--color-border-hover);
}

/* .progress-bar-container {
    height: 2px;
    background: var(--color-bg-tertiary);
    width: 100%;
    position: absolute;
    bottom: 0;
    left: 0;
} */

.progress-bar {
    height: 100%;
    background: var(--color-interactive);
    transition: width 0.5s ease;
    box-shadow: 0 0 10px var(--color-interactive);
}

/* Transitions */
.ticker-item-enter-active,
.ticker-item-leave-active {
  transition: all 0.3s ease;
  position: absolute; /* Allows overlap during transition */
}

.ticker-item-enter-from {
  opacity: 0;
  transform: translateY(20px);
}

.ticker-item-leave-to {
  opacity: 0;
  transform: translateY(-20px);
}
</style>