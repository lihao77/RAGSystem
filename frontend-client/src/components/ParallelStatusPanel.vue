<template>
  <div v-if="hasParallelTasks" class="parallel-status-panel">
    <div class="panel-header">
      <span class="panel-title">⚡ 并行执行中</span>
      <span class="running-count">{{ runningTasks.length }} / {{ totalTasks }} 个任务</span>
    </div>

    <div class="parallel-tasks-grid">
      <div
        v-for="task in runningTasks"
        :key="task.task_id || task.order"
        class="parallel-task-card"
        :class="task.status"
      >
        <div class="task-header">
          <span class="task-number">#{{ task.order }}</span>
          <span class="task-agent">{{ task.agent_display_name || task.agent_name }}</span>
        </div>

        <div class="task-description">
          {{ task.description }}
        </div>

        <div class="task-progress">
          <div class="progress-spinner">
            <div class="spinner"></div>
          </div>
          <span class="progress-text">
            {{ task.currentAction || '执行中...' }}
          </span>
        </div>

        <div v-if="task.elapsed_time" class="task-time">
          ⏱️ {{ formatTime(task.elapsed_time) }}
        </div>
      </div>
    </div>

    <!-- 已完成的任务（简洁展示） -->
    <div v-if="completedTasks.length > 0" class="completed-section">
      <div class="section-header">
        <span>✅ 已完成 ({{ completedTasks.length }})</span>
        <button class="toggle-btn" @click="showCompleted = !showCompleted">
          {{ showCompleted ? '收起' : '展开' }}
        </button>
      </div>

      <transition name="expand">
        <div v-show="showCompleted" class="completed-list">
          <div
            v-for="task in completedTasks"
            :key="task.task_id || task.order"
            class="completed-task-item"
          >
            <span class="task-number">#{{ task.order }}</span>
            <span class="task-desc">{{ task.agent_display_name || task.agent_name }}</span>
            <span class="task-time">{{ formatTime(task.execution_time) }}</span>
          </div>
        </div>
      </transition>
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue';

const props = defineProps({
  subtasks: {
    type: Array,
    required: true
  }
});

const showCompleted = ref(false);

const hasParallelTasks = computed(() => {
  // 检查是否有多个任务同时运行
  const running = props.subtasks.filter(t => t.status === 'running');
  return running.length > 1;
});

const runningTasks = computed(() => {
  return props.subtasks
    .filter(t => t.status === 'running')
    .map(task => {
      // 尝试提取当前正在执行的动作
      let currentAction = '准备中...';

      if (task.react_steps && task.react_steps.length > 0) {
        const lastStep = task.react_steps[task.react_steps.length - 1];
        if (lastStep.toolCalls && lastStep.toolCalls.length > 0) {
          const runningTool = lastStep.toolCalls.find(t => t.status === 'running');
          if (runningTool) {
            currentAction = `🛠️ ${runningTool.tool_name}`;
          }
        } else if (lastStep.thought) {
          currentAction = '思考中...';
        }
      }

      return {
        ...task,
        currentAction
      };
    });
});

const completedTasks = computed(() => {
  return props.subtasks.filter(t => t.status === 'success' || t.status === 'completed');
});

const totalTasks = computed(() => props.subtasks.length);

const formatTime = (seconds) => {
  if (!seconds) return '0s';
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${minutes}m ${secs}s`;
};
</script>

<style scoped>
.parallel-status-panel {
  margin-top: var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: transparent;
  animation: slideInUp 0.5s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--shadow-sm);
  transition: all var(--transition-normal);
}

.panel-header {
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  padding: var(--spacing-md) var(--spacing-lg);
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-weight: 600;
  border-bottom: 1px solid var(--color-border);
}

.panel-title {
  font-size: 1rem;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
}

.running-count {
  font-size: 0.9rem;
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  padding: 4px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-border);
  font-weight: 600;
}

.parallel-tasks-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--spacing-md);
  padding: var(--spacing-lg);
}

.parallel-task-card {
  background: var(--color-bg-secondary);
  border-radius: var(--radius-md);
  padding: var(--spacing-md);
  border: 2px solid var(--color-border);
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
}

.parallel-task-card::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 3px;
  background: var(--color-text-secondary);
  opacity: 0.5;
  animation: loading 2s linear infinite;
}

.parallel-task-card:hover {
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
  border-color: var(--color-border-hover);
}

.task-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--spacing-sm);
}

.task-number {
  font-weight: 700;
  color: var(--color-text-secondary);
  font-size: 0.9rem;
}

.task-agent {
  font-size: 0.75rem;
  color: var(--color-text-primary);
  background: var(--color-bg-tertiary);
  padding: 2px 8px;
  border-radius: var(--radius-sm);
  font-weight: 600;
  border: 1px solid var(--color-border);
}

.task-description {
  font-size: 0.85rem;
  color: var(--color-text-primary);
  margin-bottom: var(--spacing-md);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.task-progress {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  margin-bottom: var(--spacing-sm);
}

.progress-spinner {
  width: 20px;
  height: 20px;
}

.spinner {
  width: 100%;
  height: 100%;
  border: 2px solid var(--color-border);
  border-top-color: var(--color-text-secondary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.progress-text {
  font-size: 0.8rem;
  color: var(--color-text-secondary);
  font-weight: 500;
}

.task-time {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  text-align: right;
}

/* 已完成任务区域 */
.completed-section {
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--spacing-md) var(--spacing-lg);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.toggle-btn {
  background: transparent;
  border: 1px solid var(--color-border);
  padding: 4px 12px;
  border-radius: var(--radius-sm);
  font-size: 0.75rem;
  cursor: pointer;
  transition: all 0.2s ease;
}

.toggle-btn:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border-hover);
}

.completed-list {
  padding: 0 var(--spacing-lg) var(--spacing-md);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.completed-task-item {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-xs) var(--spacing-sm);
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  font-size: 0.85rem;
}

.completed-task-item .task-number {
  color: var(--color-success);
  min-width: 30px;
}

.completed-task-item .task-desc {
  flex: 1;
  color: var(--color-text-secondary);
}

.completed-task-item .task-time {
  color: var(--color-text-muted);
  font-size: 0.75rem;
}

/* 动画 */
@keyframes slideInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes loading {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(100%);
  }
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.expand-enter-active,
.expand-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  max-height: 500px;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  opacity: 0;
}
</style>
