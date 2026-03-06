<template>
  <div class="agent-input-card" :class="{ submitted: isSubmitted, cancelled: isCancelled }">
    <!-- 头部：图标 + 标题 + 状态 -->
    <div class="card-header">
      <div class="card-icon" :class="{ done: isSubmitted || isCancelled }">
        <!-- 等待中：气泡图标 -->
        <svg v-if="!isSubmitted && !isCancelled" xmlns="http://www.w3.org/2000/svg" width="16" height="16"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
          stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <!-- 已提交：对勾 -->
        <svg v-else-if="isSubmitted" xmlns="http://www.w3.org/2000/svg" width="14" height="14"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12"></polyline>
        </svg>
        <!-- 已取消：× -->
        <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14"
          viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
          stroke-linecap="round" stroke-linejoin="round">
          <line x1="18" y1="6" x2="6" y2="18"></line>
          <line x1="6" y1="6" x2="18" y2="18"></line>
        </svg>
      </div>
      <span class="card-label">
        {{ isSubmitted ? '已回复' : isCancelled ? '已取消' : '等待输入' }}
      </span>
      <span v-if="isSubmitted" class="submitted-value-preview">{{ submittedValue }}</span>
    </div>

    <!-- 问题 -->
    <div class="card-prompt">{{ prompt }}</div>

    <!-- 内容区：交互输入 OR 已提交的回答 -->
    <div class="card-body">

      <!-- ── 已完成态：展示提交的内容 ── -->
      <template v-if="isSubmitted">
        <div class="answer-bubble">
          <span class="answer-text">{{ submittedValue }}</span>
        </div>
      </template>

      <!-- ── 已取消 ── -->
      <template v-else-if="isCancelled">
        <div class="cancelled-hint">任务已停止</div>
      </template>

      <!-- ── 交互态 ── -->
      <template v-else>

        <!-- text 模式：textarea -->
        <div v-if="inputType === 'text'" class="text-input-area">
          <textarea
            ref="textareaRef"
            v-model="inputValue"
            class="inline-textarea"
            :placeholder="placeholder"
            rows="3"
            @keydown.ctrl.enter.prevent="handleSubmit"
            @keydown.meta.enter.prevent="handleSubmit"
            @input="autoResize"
          ></textarea>
          <div class="text-input-footer">
            <span class="hint-key">Ctrl</span>
            <span class="hint-plus">+</span>
            <span class="hint-key">Enter</span>
            <span class="hint-text">提交</span>
          </div>
        </div>

        <!-- select 模式：单选列表 -->
        <div v-else-if="inputType === 'select'" class="select-list">
          <button
            v-for="(opt, idx) in options"
            :key="idx"
            class="select-option"
            :class="{ active: inputValue === opt }"
            @click="selectOption(opt)"
          >
            <span class="option-radio">
              <span class="option-radio-inner" v-if="inputValue === opt"></span>
            </span>
            <span class="option-label">{{ opt }}</span>
          </button>
        </div>

        <!-- 底部操作栏 -->
        <div class="card-actions">
          <button class="btn-cancel" @click="handleCancel">停止任务</button>
          <button
            class="btn-submit"
            :disabled="!canSubmit"
            @click="handleSubmit"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24"
              fill="none" stroke="currentColor" stroke-width="2.5"
              stroke-linecap="round" stroke-linejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
            发送
          </button>
        </div>

      </template>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, nextTick, watch } from 'vue';

const props = defineProps({
  /** SSE 事件的完整 data 对象 */
  data: {
    type: Object,
    required: true
  }
});

const emit = defineEmits(['submit', 'cancel']);

const inputValue = ref('');
const textareaRef = ref(null);
const isSubmitted = ref(false);
const isCancelled = ref(false);
const submittedValue = ref('');

const prompt = computed(() => props.data.prompt || '请提供补充信息');
const inputType = computed(() => props.data.input_type || 'text');
const options = computed(() => Array.isArray(props.data.options) ? props.data.options : []);
const placeholder = computed(() => {
  if (inputType.value === 'select') return '';
  return '请输入…';
});

const canSubmit = computed(() => inputValue.value.trim().length > 0);

// select 单击即选中并直接提交
const selectOption = (opt) => {
  inputValue.value = opt;
  nextTick(() => handleSubmit());
};

const autoResize = () => {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
};

const handleSubmit = () => {
  if (!canSubmit.value) return;
  const val = inputValue.value.trim();
  submittedValue.value = val;
  isSubmitted.value = true;
  emit('submit', { inputId: props.data.input_id, value: val });
};

const handleCancel = () => {
  isCancelled.value = true;
  emit('cancel', { inputId: props.data.input_id });
};

// 自动聚焦
watch(() => props.data, () => {
  if (inputType.value === 'text') {
    nextTick(() => textareaRef.value?.focus());
  }
}, { immediate: true });
</script>

<style scoped>
.agent-input-card {
  margin-top: 12px;
  border: 1.5px solid var(--color-active);
  border-radius: 12px;
  background: var(--color-bg-primary);
  overflow: hidden;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.15),
              0 0 0 1px rgba(var(--color-active-rgb), 0.12);
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
  max-width: 560px;
}

.agent-input-card.submitted {
  border-color: rgba(var(--color-success-rgb), 0.5);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.agent-input-card.cancelled {
  border-color: var(--color-border);
  opacity: 0.7;
}

/* ── 头部 ── */
.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px 8px;
  border-bottom: 1px solid var(--color-border);
  background: linear-gradient(135deg, rgba(var(--color-active-rgb), 0.06) 0%, transparent 100%);
}

.submitted .card-header {
  background: linear-gradient(135deg, rgba(var(--color-success-rgb), 0.06) 0%, transparent 100%);
  border-bottom-color: transparent;
}

.card-icon {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: rgba(var(--color-active-rgb), 0.15);
  color: var(--color-active);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  animation: pulse-ring 2s ease-in-out infinite;
}

.card-icon.done {
  animation: none;
}

.submitted .card-icon {
  background: rgba(var(--color-success-rgb), 0.15);
  color: var(--color-success);
}

.cancelled .card-icon {
  background: var(--color-agent-default-bg);
  color: var(--color-text-secondary);
}

@keyframes pulse-ring {
  0%, 100% { box-shadow: 0 0 0 0 rgba(var(--color-active-rgb), 0.25); }
  50%       { box-shadow: 0 0 0 5px rgba(var(--color-active-rgb), 0); }
}

.card-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--color-active);
}

.submitted .card-label {
  color: var(--color-success);
}

.cancelled .card-label {
  color: var(--color-text-secondary);
}

.submitted-value-preview {
  margin-left: auto;
  font-size: 0.8125rem;
  color: var(--color-text-secondary);
  font-style: italic;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 200px;
}

/* ── 问题 ── */
.card-prompt {
  padding: 12px 14px 0;
  font-size: 0.9375rem;
  line-height: 1.65;
  color: var(--color-text-primary);
  font-weight: 500;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ── 内容区 ── */
.card-body {
  padding: 10px 14px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

/* 已提交：回答气泡 */
.answer-bubble {
  display: inline-flex;
  padding: 8px 12px;
  background: rgba(var(--color-success-rgb), 0.08);
  border: 1px solid rgba(var(--color-success-rgb), 0.25);
  border-radius: 8px;
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--color-text-primary);
  white-space: pre-wrap;
  word-break: break-word;
  max-width: 100%;
}

.cancelled-hint {
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  font-style: italic;
}

/* ── text 输入 ── */
.text-input-area {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.inline-textarea {
  width: 100%;
  min-height: 68px;
  max-height: 200px;
  padding: 10px 12px;
  background: var(--color-bg-secondary);
  border: 1.5px solid var(--color-border);
  border-radius: 8px;
  color: var(--color-text-primary);
  font-size: 0.9375rem;
  line-height: 1.6;
  resize: none;
  outline: none;
  box-sizing: border-box;
  font-family: inherit;
  transition: border-color 0.15s ease;
  overflow-y: hidden;
}

.inline-textarea:focus {
  border-color: var(--color-active);
  box-shadow: 0 0 0 3px rgba(var(--color-active-rgb), 0.12);
}

.text-input-footer {
  display: flex;
  align-items: center;
  gap: 3px;
  justify-content: flex-end;
}

.hint-key {
  display: inline-flex;
  align-items: center;
  padding: 1px 5px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: 4px;
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
  font-family: monospace;
}

.hint-plus,
.hint-text {
  font-size: 0.6875rem;
  color: var(--color-text-secondary);
}

/* ── select 选项 ── */
.select-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.select-option {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  background: var(--color-bg-secondary);
  border: 1.5px solid var(--color-border);
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  color: var(--color-text-primary);
  font-size: 0.9375rem;
  transition: all 0.15s ease;
  width: 100%;
}

.select-option:hover {
  border-color: var(--color-active);
  background: var(--color-bg-tertiary);
}

.select-option.active {
  border-color: var(--color-active);
  background: rgba(var(--color-active-rgb), 0.08);
  color: var(--color-text-primary);
}

.option-radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--color-border);
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color 0.15s ease;
}

.select-option.active .option-radio {
  border-color: var(--color-active);
}

.option-radio-inner {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-active);
}

.option-label {
  flex: 1;
  line-height: 1.4;
}

/* ── 操作栏 ── */
.card-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
  padding-top: 2px;
}

.btn-cancel {
  padding: 7px 14px;
  background: transparent;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  color: var(--color-text-secondary);
  font-size: 0.8125rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-cancel:hover {
  border-color: var(--color-error);
  color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.06);
}

.btn-submit {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 16px;
  background: var(--color-active);
  border: none;
  border-radius: 6px;
  color: #fff;
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-submit:hover:not(:disabled) {
  filter: brightness(1.1);
  box-shadow: 0 0 12px rgba(var(--color-active-rgb), 0.4);
  transform: translateY(-1px);
}

.btn-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn-submit:active:not(:disabled) {
  transform: scale(0.98);
}
</style>
