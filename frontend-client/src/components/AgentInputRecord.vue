<template>
  <!-- 已提交：显示问题 + 答案 -->
  <div v-if="submitted" class="input-record submitted">
    <div class="record-header">
      <span class="record-icon submitted-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"/>
        </svg>
      </span>
      <span class="record-label">已回复</span>
      <span class="record-type">{{ inputTypeLabel }}</span>
    </div>

    <div class="record-prompt">{{ prompt }}</div>

    <div class="record-answer">
      <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
        fill="none" stroke="currentColor" stroke-width="2"
        stroke-linecap="round" stroke-linejoin="round"
        class="answer-icon">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
        <circle cx="12" cy="7" r="4"/>
      </svg>
      <span class="answer-text">{{ submittedValue }}</span>
    </div>
  </div>

  <!-- 已取消 -->
  <div v-else-if="cancelled" class="input-record cancelled">
    <div class="record-header">
      <span class="record-icon cancelled-icon">
        <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"/>
          <line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </span>
      <span class="record-label">任务已停止</span>
    </div>
    <div class="record-prompt">{{ prompt }}</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  /** pendingInput 对象：SSE event data + _submitted + _cancelled */
  data: {
    type: Object,
    required: true,
  },
});

const TYPE_LABELS = {
  text:   '自由输入',
  select: '单项选择',
};

const prompt        = computed(() => props.data.prompt      || '');
const inputType     = computed(() => props.data.input_type  || 'text');
const inputTypeLabel = computed(() => TYPE_LABELS[inputType.value] ?? inputType.value);
const submitted     = computed(() => props.data._submitted != null);
const cancelled     = computed(() => !!props.data._cancelled);
const submittedValue = computed(() => props.data._submitted || '');
</script>

<style scoped>
.input-record {
  margin-top: 10px;
  border-radius: 10px;
  overflow: hidden;
  font-size: 0.875rem;
  line-height: 1.5;
  max-width: 520px;
}

/* ── 已提交 ── */
.input-record.submitted {
  border: 1px solid rgba(var(--color-success-rgb), 0.3);
  background: rgba(var(--color-success-rgb), 0.04);
}

.input-record.submitted .record-header {
  background: rgba(var(--color-success-rgb), 0.07);
  border-bottom: 1px solid rgba(var(--color-success-rgb), 0.15);
}

.submitted-icon {
  color: var(--color-success);
  background: rgba(var(--color-success-rgb), 0.15);
}

.input-record.submitted .record-label {
  color: var(--color-success);
}

/* ── 已取消 ── */
.input-record.cancelled {
  border: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  opacity: 0.7;
}

.input-record.cancelled .record-header {
  background: transparent;
  border-bottom: 1px solid var(--color-border);
}

.cancelled-icon {
  color: var(--color-text-secondary);
  background: var(--color-agent-default-bg);
}

.input-record.cancelled .record-label {
  color: var(--color-text-secondary);
}

/* ── 公共 header ── */
.record-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 12px;
}

.record-icon {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.record-label {
  font-size: 0.6875rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.4px;
}

.record-type {
  margin-left: auto;
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  opacity: 0.8;
}

/* ── 问题 ── */
.record-prompt {
  padding: 8px 12px 0;
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 回答 ── */
.record-answer {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  padding: 6px 12px 10px;
}

.answer-icon {
  color: var(--color-text-secondary);
  flex-shrink: 0;
  margin-top: 2px;
}

.answer-text {
  color: var(--color-text-primary);
  font-weight: 500;
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
