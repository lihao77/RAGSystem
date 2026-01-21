<template>
  <div class="chat-input-area">
    <div class="input-container">
      <div class="input-wrapper">
        <textarea
          v-model="inputText"
          @keydown.enter.prevent="handleEnter"
          placeholder="Ask anything..."
          rows="1"
          ref="textareaRef"
        ></textarea>
        <button
          class="send-btn"
          :disabled="!inputText.trim() || isLoading"
          @click="handleSend"
          aria-label="Send message"
        >
          <span v-if="isLoading" class="spinner"></span>
          <svg v-else xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" class="send-icon">
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
import { ref, defineProps, defineEmits, watch, nextTick } from 'vue';

const props = defineProps({
  modelValue: {
    type: String,
    default: ''
  },
  isLoading: {
    type: Boolean,
    default: false
  }
});

const emit = defineEmits(['update:modelValue', 'send']);

const inputText = ref(props.modelValue);
const textareaRef = ref(null);

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
  if (!content || props.isLoading) return;

  emit('send', content);
  inputText.value = '';
  if (textareaRef.value) {
    textareaRef.value.style.height = 'auto';
  }
};
</script>

<style scoped>
.chat-input-area {
  width: 100%;
  max-width: 750px;
  margin: 0 auto;
  position: relative;
}

.input-container {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 20px;
  padding: 8px;
  transition: all var(--transition-normal);
  transform: translateY(0);
}

.input-container:focus-within {
  border-color: var(--color-border-hover);
  background: var(--color-bg-secondary);
  box-shadow: var(--shadow-md);
}

.input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  background-color: transparent;
  padding: 0;
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
  background: var(--color-primary);
  border-color: var(--color-primary);
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

.spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--color-border);
  border-radius: 50%;
  border-top-color: var(--color-primary);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.disclaimer {
  margin-top: 12px;
  text-align: center;
  font-size: 0.7rem;
  color: var(--color-text-muted);
  opacity: 0.5;
  font-weight: 400;
  letter-spacing: 0.02em;
}
</style>