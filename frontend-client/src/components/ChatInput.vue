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
  max-width: 850px;
  margin: 0 auto;
  position: relative;
}

.input-container {
  background-color: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(10px);
  border-radius: 24px;
  box-shadow:
    0 4px 6px -1px rgba(0, 0, 0, 0.05),
    0 10px 15px -3px rgba(0, 0, 0, 0.05),
    0 0 0 1px rgba(0, 0, 0, 0.03);
  padding: 8px;
  transition: all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1);
  transform: translateY(0);
}

.input-container:focus-within {
  transform: translateY(-2px);
  box-shadow:
    0 20px 25px -5px rgba(99, 102, 241, 0.15),
    0 8px 10px -6px rgba(99, 102, 241, 0.1);
  background-color: #ffffff;
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
  padding: 12px 16px;
  border: none;
  background: transparent;
  font-size: 1rem;
  font-family: inherit;
  resize: none;
  max-height: 200px;
  overflow-y: auto;
  line-height: 1.6;
  color: var(--color-text-main);
  min-height: 48px;
}

textarea:focus {
  outline: none;
}

textarea::placeholder {
  color: var(--color-text-muted);
}

.send-btn {
  width: 42px;
  height: 42px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  background: linear-gradient(135deg, var(--color-primary), #4f46e5);
  color: white;
  border-radius: 18px;
  cursor: pointer;
  transition: all var(--transition-fast);
  margin-bottom: 3px;
  margin-right: 3px;
  box-shadow: 0 2px 4px rgba(99, 102, 241, 0.3);
}

.send-btn:hover:not(:disabled) {
  transform: scale(1.05);
  box-shadow: 0 4px 8px rgba(99, 102, 241, 0.4);
}

.send-btn:disabled {
  background: var(--color-bg-app);
  color: var(--color-text-muted);
  cursor: not-allowed;
  box-shadow: none;
}

.send-icon {
  width: 20px;
  height: 20px;
}

.spinner {
  width: 18px;
  height: 18px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-radius: 50%;
  border-top-color: white;
  animation: spin 0.8s linear infinite;
}

.send-btn:disabled .spinner {
  border-color: var(--color-border);
  border-top-color: var(--color-text-muted);
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.disclaimer {
  margin-top: 12px;
  text-align: center;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  opacity: 0.8;
  font-weight: 500;
}
</style>