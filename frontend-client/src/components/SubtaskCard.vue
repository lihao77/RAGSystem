<template>
  <div class="subtask-card">
    <div class="subtask-header" @click="toggleExpanded">
      <span class="icon">{{ subtask.expanded ? '▼' : '▶' }}</span>
      <span class="subtask-title">
        <span class="subtask-number">步骤 {{ subtask.order }}</span>
        <span class="subtask-agent">{{ subtask.agent_display_name }}</span>
      </span>
      <span class="subtask-status" :class="subtask.status">
        {{ getStatusText(subtask.status) }}
      </span>
    </div>

    <!-- 折叠状态：预览 -->
    <div v-if="!subtask.expanded" class="subtask-preview">
      <div class="subtask-description">{{ subtask.description }}</div>
      <div v-if="subtask.result_summary" class="subtask-summary">
        {{ subtask.result_summary }}
      </div>
    </div>

    <!-- 展开状态：详情 -->
    <div v-if="subtask.expanded" class="subtask-details">
      <div class="subtask-description-full">
        <strong>任务描述：</strong>{{ subtask.description }}
      </div>

      <!-- 推理步骤 -->
      <ThinkingSteps
        v-if="subtask.thinking_steps && subtask.thinking_steps.length > 0"
        :steps="subtask.thinking_steps"
      />

      <!-- 工具调用 -->
      <ToolCallsList
        v-if="subtask.tool_calls && subtask.tool_calls.length > 0"
        :toolCalls="subtask.tool_calls"
      />

      <!-- 结果摘要 -->
      <div v-if="subtask.result_summary" class="subtask-result">
        <div class="section-header">📋 结果摘要</div>
        <div class="result-content">{{ subtask.result_summary }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { defineProps, defineEmits } from 'vue';
import ThinkingSteps from './ThinkingSteps.vue';
import ToolCallsList from './ToolCallsList.vue';

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
</script>

<style scoped>
/* 子任务卡片 */
.subtask-card {
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  overflow: hidden;
  background-color: #ffffff;
  transition: box-shadow 0.2s ease;
  animation: fadeInUp 0.5s ease;
}

.subtask-card:hover {
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
}

.subtask-header {
  background-color: #f8f9fa;
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  border-bottom: 1px solid #e8e8e8;
  transition: background-color 0.2s ease;
}

.subtask-header:hover {
  background-color: #f0f0f0;
}

.subtask-title {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
}

.subtask-number {
  font-weight: 700;
  color: #4a5568;
  font-size: 13px;
}

.subtask-agent {
  padding: 2px 8px;
  background-color: #e9d5ff;
  color: #6b21a8;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
}

.subtask-status {
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 12px;
}

.subtask-status.running {
  background-color: #fef3c7;
  color: #d97706;
}

.subtask-status.success {
  background-color: #dcfce7;
  color: #16a34a;
}

.subtask-status.error {
  background-color: #fee2e2;
  color: #dc2626;
}

.icon {
  font-size: 10px;
  transition: transform 0.2s ease;
}

/* 预览（折叠状态） */
.subtask-preview {
  padding: 12px 16px;
  background-color: #fafafa;
  animation: fadeIn 0.3s ease;
}

.subtask-description {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.5;
  margin-bottom: 8px;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

.subtask-summary {
  font-size: 12px;
  color: #718096;
  font-style: italic;
  padding-left: 16px;
  border-left: 2px solid #cbd5e0;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* 详情（展开状态） */
.subtask-details {
  padding: 16px;
  background-color: #ffffff;
  animation: expandDown 0.3s ease;
}

.subtask-description-full {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  margin-bottom: 16px;
  padding-bottom: 16px;
  border-bottom: 1px solid #f0f0f0;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

.section-header {
  font-size: 13px;
  font-weight: 600;
  color: #4a5568;
  margin: 16px 0 12px 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

/* 结果摘要 */
.subtask-result {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid #f0f0f0;
}

.result-content {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  padding: 12px;
  background-color: #f0fdf4;
  border-left: 3px solid #22c55e;
  border-radius: 4px;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
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

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
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
