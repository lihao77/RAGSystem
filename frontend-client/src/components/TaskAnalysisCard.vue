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
  border: 1px solid #dbeafe;
  border-radius: 8px;
  overflow: hidden;
  background-color: #eff6ff;
  animation: fadeInUp 0.4s ease;
}

.card-header {
  background-color: #dbeafe;
  padding: 12px 16px;
  font-size: 13px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  transition: background-color 0.2s ease;
}

.card-header:hover {
  background-color: #bfdbfe;
}

.card-title {
  font-weight: 600;
  color: #1e40af;
}

.task-badge {
  padding: 2px 8px;
  background-color: #3b82f6;
  color: white;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}

.subtask-count {
  margin-left: auto;
  font-size: 12px;
  color: #1e40af;
  font-weight: 600;
}

.icon {
  font-size: 10px;
  transition: transform 0.2s ease;
}

.card-content {
  padding: 16px;
  background-color: #ffffff;
  border-top: 1px solid #bfdbfe;
  animation: expandDown 0.3s ease;
}

.analysis-reasoning {
  font-size: 13px;
  color: #4a5568;
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
