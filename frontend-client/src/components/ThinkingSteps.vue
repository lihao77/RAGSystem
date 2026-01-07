<template>
  <div class="thinking-steps">
    <div class="section-header">🤔 推理过程 ({{ steps.length }} 步)</div>
    <div v-for="(step, index) in steps" :key="index" class="thinking-step">
      <div class="step-meta">
        <span class="step-number">{{ index + 1 }}</span>
        <span class="step-type">
          {{ getStepType(step) }}
        </span>
      </div>
      <div class="step-content">{{ step.thought }}</div>
    </div>
  </div>
</template>

<script setup>
import { defineProps } from 'vue';

defineProps({
  steps: {
    type: Array,
    required: true
  }
});

const getStepType = (step) => {
  if (step.has_actions) return '🔧 调用工具';
  if (step.has_answer) return '✅ 得出答案';
  return '🤔 思考中';
};
</script>

<style scoped>
.thinking-steps {
  margin-bottom: 16px;
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

.thinking-step {
  margin-bottom: 12px;
  padding: 12px;
  background-color: #faf5ff;
  border-left: 3px solid #a855f7;
  border-radius: 4px;
  animation: fadeInUp 0.4s ease;
}

.thinking-step:last-child {
  margin-bottom: 0;
}

.step-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border-radius: 50%;
  font-size: 12px;
  font-weight: 600;
}

.step-type {
  font-size: 12px;
  color: #718096;
  font-weight: 500;
}

.step-content {
  font-size: 13px;
  color: #4a5568;
  line-height: 1.6;
  margin-left: 36px;
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
</style>
