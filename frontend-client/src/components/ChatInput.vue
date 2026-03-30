<template>
  <div class="chat-input-area">
    <div class="input-container">
      <div v-if="attachments.length" class="attachment-preview-list">
        <div v-for="attachment in attachments" :key="attachment.file_id || attachment.id || attachment.stored_name" class="attachment-preview-chip">
          <span class="attachment-preview-name">{{ attachment.original_name || attachment.stored_name }}</span>
          <button
            type="button"
            class="attachment-preview-remove"
            @click="emit('removeAttachment', attachment)"
            :disabled="isLoading"
            aria-label="移除附件"
          >
            ×
          </button>
        </div>
      </div>
      <div class="input-wrapper">
        <button
          type="button"
          class="attachment-btn"
          :disabled="isLoading"
          @click="emit('openAttachments')"
          aria-label="打开附件面板"
          title="添加图片或文件"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="attachment-icon">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.82-2.82l8.49-8.48" />
          </svg>
        </button>
        <textarea
          v-model="inputText"
          @keydown.enter.prevent="handleEnter"
          placeholder="Ask anything..."
          rows="1"
          ref="textareaRef"
        ></textarea>
        <button
          v-if="isLoading"
          class="send-btn stop-btn"
          @click="handleStop"
          aria-label="Stop generation"
        >
          <span class="stop-icon">■</span>
        </button>
        <button
          v-else
          class="send-btn"
          :disabled="sendDisabled"
          @click="handleSend"
          aria-label="Send message"
        >
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="send-icon">
            <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
          </svg>
        </button>
      </div>
    </div>
    <div class="disclaimer">
      AI can make mistakes. Please verify important information.
    </div>
  </div>
</template>

<script setup>
import { ref, defineProps, defineEmits, watch, nextTick, computed } from 'vue';

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  isLoading: {
    type: Boolean,
    default: false
  },
  attachments: {
    type: Array,
    default: () => []
  }
});

const emit = defineEmits(['update:modelValue', 'send', 'stop', 'openAttachments', 'removeAttachment']);

const inputText = ref(props.modelValue);
const textareaRef = ref(null);

const sendDisabled = computed(() => props.isLoading || (!inputText.value.trim() && !props.attachments.length));

watch(() => props.modelValue, (newValue) => {
  inputText.value = newValue;
});

watch(inputText, (newValue) => {
  emit('update:modelValue', newValue);
  adjustTextareaHeight();
});

const adjustTextareaHeight = async () => {
  await nextTick();
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
    textareaRef.value.style.height = Math.min(textareaRef.value.scrollHeight, 200) + 'px';
  }
};

const handleEnter = (event) => {
  if (event.shiftKey) {
    return;
  }
  handleSend();
};

const handleSend = () => {
  const content = inputText.value.trim();
  if (props.isLoading || (!content && !props.attachments.length)) return;

  emit('send', {
    content,
    attachments: props.attachments,
  });
  inputText.value = '';
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
  }
};

const handleStop = () => {
  emit('stop');
};

const focus = async () => {
  await nextTick();
  if (textareaRef.value) {
    textareaRef.value.focus();
  }
};

defineExpose({ focus });
</script>

<style scoped>
.chat-input-area {
  width: 100%;
  max-width: 800px;
  margin: 0 auto;
  position: relative;
}

.input-container {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 24px;
  padding: 8px;
  transition: all var(--transition-normal);
  transform: translateY(0);
}

.input-container:focus-within {
  border-color: var(--color-border-hover);
  box-shadow: var(--shadow-md);
}

.attachment-preview-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 6px 6px 10px;
}

.attachment-preview-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  padding: 6px 10px;
  border-radius: 999px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  font-size: 0.82rem;
}

.attachment-preview-name {
  max-width: 240px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-preview-remove {
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;
  font-size: 16px;
  line-height: 1;
  padding: 0;
}

.input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  background-color: transparent;
  padding: 0;
}

.attachment-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  border-radius: 12px;
  cursor: pointer;
  transition: all var(--transition-fast);
  margin-bottom: 4px;
  margin-left: 4px;
  flex-shrink: 0;
}

.attachment-btn:hover:not(:disabled) {
  background: var(--color-bg-secondary);
  border-color: var(--color-border-hover);
}

.attachment-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.attachment-icon {
  width: 18px;
  height: 18px;
}

textarea {
  flex: 1;
  padding: 10px 14px;
  border: none;
  background: transparent;
  font-size: 0.95rem;
  font-family: inherit;
  resize: none;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.5;
  color: var(--color-text-primary);
  min-height: 44px;
}

textarea:focus {
  outline: none;
}

textarea::placeholder {
  color: var(--color-text-muted);
}

.send-btn {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--color-border);
  background: var(--color-bg-elevated);
  color: var(--color-text-primary);
  border-radius: 12px;
  cursor: pointer;
  transition: all var(--transition-fast);
  margin-bottom: 4px;
  margin-right: 4px;
}

.send-btn:hover:not(:disabled) {
  background: var(--color-interactive);
  border-color: var(--color-interactive);
  color: white;
}

.send-btn:disabled {
  background: transparent;
  color: var(--color-text-muted);
  cursor: not-allowed;
  border-color: transparent;
  opacity: 0.5;
}

.send-icon {
  width: 18px;
  height: 18px;
}

.stop-btn {
  background: var(--color-interactive) !important;
  border-color: var(--color-interactive) !important;
  color: white !important;
  opacity: 1 !important;
  cursor: pointer !important;
}

.stop-btn:hover {
  opacity: 0.85 !important;
}

.stop-icon {
  font-size: 14px;
  line-height: 1;
}

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-radius: 50%;
  border-top-color: var(--color-interactive);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.disclaimer {
  margin: var(--spacing-sm) 0;
  text-align: center;
  font-size: 0.7rem;
  color: var(--color-text-muted);
  opacity: 0.5;
  font-weight: 400;
  letter-spacing: 0.02em;
}
</style>
