<template>
  <div v-if="shouldShow" class="task-analysis-card">
    <div class="card-header" @click="toggleExpanded">
      <span class="icon" :class="{ expanded: taskAnalysis.expanded }">▶</span>
      <span class="card-title">🧠 任务分析</span>
      <span class="task-badge">{{ taskAnalysis.complexity }}</span>
      <span class="subtask-count">{{ taskAnalysis.subtask_count }} 个子任务</span>
    </div>
    <transition name="expand">
      <div v-show="taskAnalysis.expanded" class="card-content">
        <div class="analysis-reasoning">{{ taskAnalysis.reasoning }}</div>
      </div>
    </transition>
  </div>
</template>

<script setup>
import { computed, defineProps, defineEmits } from 'vue';

const props = defineProps({
  taskAnalysis: {
    type: Object,
    default: null
  }
});

const emit = defineEmits(['update:expanded']);

// 只在有多个子任务或复杂任务时显示
const shouldShow = computed(() => {
  return props.taskAnalysis &&
    (props.taskAnalysis.subtask_count > 1 || props.taskAnalysis.complexity !== 'simple');
});

const toggleExpanded = () => {
  if (props.taskAnalysis) {
    emit('update:expanded', !props.taskAnalysis.expanded);
  }
};
</script>

<style scoped>
.task-analysis-card {
  margin-top: var(--spacing-md);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--glass-bg-light);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  animation: fadeInUp 0.4s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: var(--glass-shadow);
  transition: all var(--transition-normal);
}

.task-analysis-card:hover {
  background: var(--color-bg-secondary);
  border-color: var(--color-border-hover);
}

.card-header {
  background: var(--color-bg-elevated);
  padding: var(--spacing-md);
  font-size: 0.9rem;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  font-weight: 600;
  transition: all var(--transition-fast);
}

.card-header:hover {
  background: var(--color-bg-tertiary);
}

.card-title {
  font-weight: 600;
  color: var(--color-primary-hover);
}

.task-badge {
  padding: 4px 12px;
  background: var(--color-primary-subtle);
  color: var(--color-primary-hover);
  border-radius: var(--radius-full);
  font-size: 0.75rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  border: 1px solid var(--color-border);
}

.subtask-count {
  margin-left: auto;
  font-size: 0.85rem;
  color: var(--color-text-secondary);
  font-weight: 600;
}

.icon {
  font-size: 10px;
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  color: var(--color-text-muted);
  display: inline-block;
}

.icon.expanded {
  transform: rotate(90deg);
}

.card-content {
  padding: var(--spacing-lg);
  background: transparent;
  overflow: hidden;
}

.analysis-reasoning {
  font-size: 0.9rem;
  color: var(--color-text-secondary);
  line-height: 1.8;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* Expand/Collapse Transition */
.expand-enter-active,
.expand-leave-active {
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  max-height: 500px;
}

.expand-enter-from,
.expand-leave-to {
  max-height: 0;
  padding-top: 0;
  padding-bottom: 0;
  opacity: 0;
}

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