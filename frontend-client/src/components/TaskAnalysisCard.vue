<template>
  <div v-if="shouldShow" class="task-analysis-card">
    <div class="card-header" @click="toggleExpanded">
      <span class="icon">{{ taskAnalysis.expanded ? '▼' : '▶' }}</span>
      <span class="card-title">🧠 任务分析</span>
      <span class="task-badge">{{ taskAnalysis.complexity }}</span>
      <span class="subtask-count">{{ taskAnalysis.subtask_count }} 个子任务</span>
    </div>
    <div v-if="taskAnalysis.expanded" class="card-content">
      <div class="analysis-reasoning">{{ taskAnalysis.reasoning }}</div>
    </div>
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
  margin-top: 16px;
  border: var(--glass-border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: rgba(255, 255, 255, 0.45);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  animation: fadeInUp 0.4s ease;
  box-shadow: var(--glass-shadow);
  transition: all 0.3s ease;
}

.task-analysis-card:hover {
  background: rgba(255, 255, 255, 0.55);
  box-shadow: 0 12px 40px 0 rgba(31, 38, 135, 0.1);
}

.card-header {
  background: rgba(255, 255, 255, 0.3);
  padding: 12px 16px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  transition: background 0.2s ease;
  border-bottom: 1px solid rgba(255, 255, 255, 0.2);
}

.card-header:hover {
  background: rgba(255, 255, 255, 0.5);
}

.card-title {
  font-weight: 600;
  color: var(--color-primary);
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.5);
}

.task-badge {
  padding: 2px 10px;
  background: linear-gradient(135deg, rgba(224, 231, 255, 0.8), rgba(199, 210, 254, 0.8));
  color: var(--color-primary);
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  border: 1px solid rgba(255, 255, 255, 0.6);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.02);
}

.subtask-count {
  margin-left: auto;
  font-size: 12px;
  color: var(--color-text-secondary);
  font-weight: 600;
}

.icon {
  font-size: 10px;
  transition: transform 0.2s ease;
  color: var(--color-text-muted);
}

.card-content {
  padding: 16px;
  background: transparent;
  border-top: 1px solid rgba(255, 255, 255, 0.3);
  animation: expandDown 0.3s ease;
}

.analysis-reasoning {
  font-size: 13px;
  color: var(--color-text-secondary);
  line-height: 1.6;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
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

@keyframes expandDown {
  from {
    opacity: 0;
    max-height: 0;
    padding-top: 0;
    padding-bottom: 0;
  }
  to {
    opacity: 1;
    max-height: 2000px;
    padding-top: 16px;
    padding-bottom: 16px;
  }
}
</style>