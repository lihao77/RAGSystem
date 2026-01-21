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

      <!-- ReAct 推理流程（新版） -->
      <ReActStepsList
        v-if="subtask.react_steps && subtask.react_steps.length > 0"
        :steps="subtask.react_steps"
      />

      <!-- 结果摘要（展开后显示完整内容） -->
      <div v-if="subtask.result_summary" class="subtask-result">
        <div class="section-header">📋 完整结果</div>
        <!-- 使用 Markdown 渲染或预格式化文本 -->
        <div class="result-content-full">{{ subtask.result_summary }}</div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { defineProps, defineEmits } from 'vue';
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
</script>

<style scoped>
/* 子任务卡片 */
.subtask-card {
  border: var(--glass-border);
  border-radius: 12px;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.4);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  transition: all 0.3s ease;
  animation: fadeInUp 0.5s ease;
  box-shadow: var(--glass-shadow);
}

.subtask-card:hover {
  background: rgba(255, 255, 255, 0.5);
  box-shadow: var(--glass-shadow);
}

.subtask-header {
  background: rgba(255, 255, 255, 0.3);
  padding: 12px 16px;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  /* border-bottom: 1px solid rgba(255, 255, 255, 0.2); */
  transition: background 0.2s ease;
}

.subtask-header:hover {
  background: rgba(255, 255, 255, 0.7);
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
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.5);
}

.subtask-agent {
  padding: 2px 10px;
  background: linear-gradient(135deg, rgba(233, 213, 255, 0.7), rgba(216, 180, 254, 0.7));
  color: #6b21a8;
  border-radius: 12px;
  font-size: 11px;
  font-weight: 600;
  border: 1px solid rgba(255, 255, 255, 0.5);
}

.subtask-status {
  font-size: 12px;
  font-weight: 600;
  padding: 4px 10px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.5);
  backdrop-filter: blur(4px);
}

.subtask-status.running {
  background: linear-gradient(135deg, rgba(254, 243, 199, 0.7), rgba(253, 230, 138, 0.7));
  color: #d97706;
}

.subtask-status.success {
  background: linear-gradient(135deg, rgba(220, 252, 231, 0.7), rgba(187, 247, 208, 0.7));
  color: #16a34a;
}

.subtask-status.error {
  background: linear-gradient(135deg, rgba(254, 226, 226, 0.7), rgba(254, 202, 202, 0.7));
  color: #dc2626;
}

.icon {
  font-size: 10px;
  transition: transform 0.2s ease;
}

/* 预览（折叠状态） */
.subtask-preview {
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.2);
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
  /* font-style: italic; */
  padding-left: 16px;
  border-left: 2px solid rgba(203, 213, 224, 0.6);
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
}

/* 详情（展开状态） */
.subtask-details {
  padding: 16px;
  background: rgba(255, 255, 255, 0.3);
  animation: expandDown 0.3s ease;
}

.subtask-description-full {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  margin-bottom: 16px;
  /* padding-bottom: 16px; */
  /* border-bottom: 1px solid rgba(255, 255, 255, 0.3); */
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
  text-shadow: 0 1px 1px rgba(255, 255, 255, 0.5);
}

/* 结果摘要 */
.subtask-result {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid rgba(255, 255, 255, 0.3);
}

/* 完整结果样式 */
.result-content-full {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  padding: 16px;
  background: rgba(240, 253, 244, 0.6);
  backdrop-filter: blur(4px);
  border-left: 3px solid #22c55e;
  border-radius: 4px;
  word-wrap: break-word;
  word-break: break-word;
  overflow-wrap: break-word;
  white-space: pre-wrap; /* 保持换行 */
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace; /* 使用等宽字体以对齐数据 */
  max-height: 400px;
  overflow-y: auto; /* 内容过长时滚动 */
  box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.02);
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