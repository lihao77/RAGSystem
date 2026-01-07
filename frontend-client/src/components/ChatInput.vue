<template>
  <div class="chat-input-area">
    <div class="input-wrapper">
      <textarea
        v-model="inputText"
        @keydown.enter.prevent="handleEnter"
        placeholder="输入您的问题..."
        rows="1"
        ref="textareaRef"
      ></textarea>
      <button :disabled="!inputText.trim() || isLoading" @click="handleSend">
        发送
      </button>
    </div>
    <div class="disclaimer">
      AI 可能会生成不准确的信息，请核实重要信息。
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
    textareaRef.value.style.height = textareaRef.value.scrollHeight + 'px';
  }
};

const handleEnter = (event) => {
  if (event.shiftKey) {
    // Shift+Enter: 换行
    return;
  }
  // Enter: 发送
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
  padding: 20px;
  background-color: #ffffff;
  border-top: 1px solid #e8e8e8;
}

.input-wrapper {
  display: flex;
  gap: 12px;
  align-items: flex-end;
}

textarea {
  flex: 1;
  padding: 12px 16px;
  border: 2px solid #e8e8e8;
  border-radius: 12px;
  font-size: 15px;
  font-family: inherit;
  resize: none;
  max-height: 200px;
  overflow-y: auto;
  transition: border-color 0.2s ease;
  line-height: 1.5;
}

textarea:focus {
  outline: none;
  border-color: #5a67d8;
}

button {
  padding: 12px 24px;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

button:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.disclaimer {
  margin-top: 12px;
  text-align: center;
  font-size: 12px;
  color: #a0aec0;
}
</style>
