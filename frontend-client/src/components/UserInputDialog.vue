<template>
  <Teleport to="body">
    <Transition name="dialog-fade">
      <div v-if="visible" class="input-overlay" @click="handleOverlayClick">
        <div class="input-container" @click.stop>
          <div class="input-header">
            <div class="input-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none"
                stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
            </div>
            <h3 class="input-title">需要补充信息</h3>
          </div>

          <div class="input-body">
            <div class="input-prompt">{{ prompt }}</div>

            <!-- 文本输入 -->
            <div v-if="inputType === 'text'" class="input-field-wrapper">
              <textarea
                ref="textareaRef"
                v-model="inputValue"
                class="input-textarea"
                placeholder="请输入..."
                rows="3"
                @keydown.ctrl.enter.prevent="handleSubmit"
                @keydown.meta.enter.prevent="handleSubmit"
              />
              <div class="input-hint">Ctrl+Enter 提交</div>
            </div>

            <!-- 选项选择 -->
            <div v-else-if="inputType === 'select'" class="options-list">
              <button
                v-for="(opt, idx) in options"
                :key="idx"
                class="option-btn"
                :class="{ selected: inputValue === opt }"
                @click="inputValue = opt"
              >
                <span class="option-check">
                  <svg v-if="inputValue === opt" xmlns="http://www.w3.org/2000/svg" width="14" height="14"
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"
                    stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </span>
                {{ opt }}
              </button>
            </div>
          </div>

          <div class="input-footer">
            <button class="input-btn input-btn-cancel" @click="handleCancel">
              取消任务
            </button>
            <button
              class="input-btn input-btn-submit"
              :disabled="!canSubmit"
              @click="handleSubmit"
            >
              提交
            </button>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup>
import { ref, computed, nextTick } from 'vue';

const emit = defineEmits(['submit', 'cancel']);

const visible = ref(false);
const prompt = ref('');
const inputType = ref('text');
const options = ref([]);
const inputValue = ref('');
const textareaRef = ref(null);

let _inputId = '';
let _onSubmit = null;
let _onCancel = null;

const canSubmit = computed(() => {
  return inputValue.value.trim().length > 0;
});

/**
 * 显示对话框
 * @param {object} data - { input_id, prompt, input_type, options }
 * @param {function} onSubmit - (inputId, value) => void
 * @param {function} onCancel - () => void
 */
const show = (data, onSubmit, onCancel) => {
  _inputId = data.input_id || '';
  prompt.value = data.prompt || '请输入补充信息';
  inputType.value = data.input_type || 'text';
  options.value = Array.isArray(data.options) ? data.options : [];
  inputValue.value = '';
  _onSubmit = onSubmit || null;
  _onCancel = onCancel || null;
  visible.value = true;

  // 自动聚焦文本框
  if (inputType.value === 'text') {
    nextTick(() => {
      textareaRef.value?.focus();
    });
  }
};

const hide = () => {
  visible.value = false;
  inputValue.value = '';
};

const handleSubmit = () => {
  if (!canSubmit.value) return;
  const val = inputValue.value.trim();
  hide();
  if (_onSubmit) _onSubmit(_inputId, val);
  emit('submit', { inputId: _inputId, value: val });
};

const handleCancel = () => {
  hide();
  if (_onCancel) _onCancel(_inputId);
  emit('cancel', { inputId: _inputId });
};

// 点击遮罩不关闭（强制用户做出选择）
const handleOverlayClick = () => {};

defineExpose({ show, hide });
</script>

<style scoped>
.input-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: var(--spacing-md);
}

.input-container {
  background: var(--color-bg-primary);
  border: 2px solid var(--color-accent);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 80px rgba(0, 0, 0, 0.6), 0 0 0 1px rgba(99, 179, 237, 0.2);
  max-width: 480px;
  width: 100%;
  overflow: hidden;
  animation: containerSlideIn 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
}

@keyframes containerSlideIn {
  from { transform: scale(0.9) translateY(-20px); opacity: 0; }
  to   { transform: scale(1) translateY(0); opacity: 1; }
}

.input-header {
  padding: var(--spacing-lg);
  border-bottom: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  background: linear-gradient(135deg, rgba(99, 179, 237, 0.1) 0%, transparent 100%);
}

.input-icon {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  background: var(--color-accent);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-bg-primary);
  flex-shrink: 0;
}

.input-title {
  margin: 0;
  font-size: 1.125rem;
  font-weight: 600;
  color: var(--color-text-primary);
}

.input-body {
  padding: var(--spacing-lg);
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.input-prompt {
  font-size: 0.9375rem;
  line-height: 1.6;
  color: var(--color-text-primary);
  font-weight: 500;
  padding: var(--spacing-md);
  background: var(--color-bg-secondary);
  border-left: 3px solid var(--color-accent);
  border-radius: var(--radius-sm);
}

.input-field-wrapper {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.input-textarea {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font-size: 0.9375rem;
  line-height: 1.6;
  resize: vertical;
  outline: none;
  transition: border-color var(--transition-fast);
  font-family: inherit;
  box-sizing: border-box;
}

.input-textarea:focus {
  border-color: var(--color-accent);
}

.input-hint {
  font-size: 0.75rem;
  color: var(--color-text-secondary);
  text-align: right;
}

/* 选项列表 */
.options-list {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xs);
}

.option-btn {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font-size: 0.9375rem;
  text-align: left;
  cursor: pointer;
  transition: all var(--transition-fast);
}

.option-btn:hover {
  border-color: var(--color-accent);
  background: var(--color-bg-tertiary);
}

.option-btn.selected {
  border-color: var(--color-accent);
  background: rgba(99, 179, 237, 0.1);
  color: var(--color-accent);
  font-weight: 500;
}

.option-check {
  width: 18px;
  height: 18px;
  border: 1.5px solid currentColor;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  opacity: 0.6;
}

.option-btn.selected .option-check {
  opacity: 1;
  background: var(--color-accent);
  border-color: var(--color-accent);
  color: var(--color-bg-primary);
}

/* 底部按钮 */
.input-footer {
  padding: var(--spacing-md) var(--spacing-lg) var(--spacing-lg);
  display: flex;
  gap: var(--spacing-sm);
  justify-content: flex-end;
}

.input-btn {
  padding: 10px 24px;
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all var(--transition-fast);
  border: none;
  outline: none;
  flex: 1;
}

.input-btn-cancel {
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
}

.input-btn-cancel:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.input-btn-submit {
  background: var(--color-accent);
  color: var(--color-bg-primary);
}

.input-btn-submit:hover:not(:disabled) {
  filter: brightness(1.1);
  box-shadow: 0 0 16px rgba(99, 179, 237, 0.4);
  transform: translateY(-1px);
}

.input-btn-submit:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.input-btn:active:not(:disabled) {
  transform: scale(0.98);
}

/* 动画 */
.dialog-fade-enter-active,
.dialog-fade-leave-active {
  transition: opacity 0.2s ease;
}
.dialog-fade-enter-from,
.dialog-fade-leave-to {
  opacity: 0;
}

/* 移动端适配 */
@media (max-width: 767px) {
  .input-container {
    max-width: calc(100vw - 32px);
  }
  .input-header,
  .input-body {
    padding: var(--spacing-md);
  }
  .input-footer {
    padding: var(--spacing-sm) var(--spacing-md) var(--spacing-md);
    flex-direction: column-reverse;
  }
}
</style>
