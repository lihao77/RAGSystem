<template>
  <div class="floating-chat-panel" :class="{ collapsed: isCollapsed }">
    <div class="panel-body" @click="isCollapsed && toggleCollapse(false)">
      <!-- 面板主体 -->
      <div class="panel-main">
        <div class="panel-header">
          <div class="panel-title-group">
            <span class="status-dot" :class="isStreaming ? 'streaming' : 'connected'"></span>
            <span class="panel-title">智能对话</span>
          </div>
          <Button variant="ghost" size="icon" aria-label="收起" title="收起" @click.stop="toggleCollapse(true)">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </Button>
        </div>

        <div class="panel-messages" ref="messagesContainer">
          <div v-for="(msg, idx) in messages" :key="idx" class="chat-msg" :class="msg.role">
            <div class="msg-bubble">
              <div v-if="msg.role === 'user'" class="msg-content">{{ msg.content }}</div>
              <MarkdownContent v-else :content="msg.content" :render-markdown="renderWithViz" />
            </div>
          </div>
          <div v-if="isStreaming" class="streaming-indicator">
            <span class="dot"></span><span class="dot"></span><span class="dot"></span>
          </div>
        </div>

        <div class="panel-input">
          <div class="input-wrapper">
            <textarea
              ref="inputRef"
              v-model="inputText"
              @keydown.enter.exact.prevent="sendMessage"
              placeholder="Ask anything..."
              rows="1"
            ></textarea>
            <Button variant="default" size="icon" aria-label="发送" title="发送" :disabled="!inputText.trim() || isStreaming" @click="sendMessage">
              <IconSend :size="16" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';
import { renderMarkdown } from '../utils/markdown';
import MarkdownContent from './chat/MarkdownContent.vue';
import IconSend from './icons/IconSend.vue';
import { Button } from './ui/button';

const props = defineProps({
  messages: { type: Array, default: () => [] },
  isStreaming: { type: Boolean, default: false },
  prefillText: { type: String, default: '' },
});

const emit = defineEmits(['send-message', 'close', 'collapse-change']);

const isCollapsed = ref(false);
const inputText = ref('');
const messagesContainer = ref(null);
const inputRef = ref(null);
const unreadCount = ref(0);

const toggleCollapse = (val) => {
  isCollapsed.value = val;
  emit('collapse-change', val);
};

// 主渲染器 + viz 标记后处理（[viz:viz_xxx] → 地图可视化入口，悬浮窗特有）
const renderWithViz = (content) =>
  renderMarkdown(content || '').replace(
    /\[viz:(viz_\w+)\]/g,
    '<span class="viz-link">[ 地图可视化 ]</span>',
  );

const sendMessage = () => {
  const text = inputText.value.trim();
  if (!text || props.isStreaming) return;
  emit('send-message', text);
  inputText.value = '';
};

watch(() => props.prefillText, (val) => {
  if (val) {
    inputText.value = val;
    toggleCollapse(false);
    nextTick(() => inputRef.value?.focus());
  }
});

watch(() => props.messages.length, () => {
  if (isCollapsed.value) {
    unreadCount.value++;
  }
  nextTick(() => {
    if (messagesContainer.value) {
      messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
    }
  });
});

watch(isCollapsed, (val) => {
  if (!val) {
    unreadCount.value = 0;
    nextTick(() => {
      if (messagesContainer.value) {
        messagesContainer.value.scrollTop = messagesContainer.value.scrollHeight;
      }
    });
  }
});
</script>

<style scoped>
.floating-chat-panel {
  position: fixed;
  right: 0;
  top: 64px;
  bottom: 16px;
  z-index: 10002;
}

.panel-body {
  height: 100%;
  display: flex;
  transform: translateX(0);
  transition: transform 0.35s var(--ease-material);
}

.collapsed .panel-body {
  /* 露出面板左侧 20px */
  transform: translateX(calc(100% - 20px));
  cursor: pointer;
}

/* 面板主体 */
.panel-main {
  width: 380px;
  height: 100%;
  margin-right: 16px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(180%);
  border: 1px solid var(--color-glass-border);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: var(--shadow-lg);
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid var(--color-border);
  flex-shrink: 0;
}

.panel-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-dot.connected {
  background: var(--color-success);
}

.status-dot.streaming {
  background: var(--color-warning);
  animation: pulse 1.5s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; }
  50% { opacity: 1; }
}

.panel-title {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--color-text-primary);
}

.panel-messages {
  flex: 1;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.chat-msg {
  display: flex;
  flex-direction: column;
  width: 100%;
}

.chat-msg.user {
  align-items: flex-end;
}

.chat-msg.assistant {
  align-items: flex-start;
}

.msg-bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: var(--radius-lg);
  font-size: var(--font-size-sm);
  line-height: 1.6;
  word-break: break-word;
}

.chat-msg.user .msg-bubble {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  border-bottom-right-radius: 4px;
}

.chat-msg.assistant .msg-bubble {
  background: transparent;
  color: var(--color-text-primary);
  max-width: 100%;
  padding: 4px 0;
}

.msg-content {
  word-break: break-word;
  line-height: 1.6;
}

.streaming-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
}

.dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--color-text-muted);
  animation: dotPulse 1.2s infinite ease-in-out;
}

.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes dotPulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

.panel-input {
  padding: 10px 12px;
  border-top: 1px solid var(--color-border);
  flex-shrink: 0;
}

.input-wrapper {
  display: flex;
  align-items: flex-end;
  gap: var(--spacing-sm);
  background: var(--color-bg-primary);
  border: 1px solid var(--color-border);
  border-radius: 24px;
  padding: 4px;
  transition: all 0.2s;
}

.input-wrapper:focus-within {
  border-color: var(--color-border-hover);
  box-shadow: var(--shadow-sm);
}

.panel-input textarea {
  flex: 1;
  background: transparent;
  border: none;
  padding: 8px 12px;
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  resize: none;
  outline: none;
  min-height: 32px;
  max-height: 100px;
  font-family: inherit;
  line-height: 1.5;
}

.panel-input textarea::placeholder {
  color: var(--color-text-muted);
}

.panel-messages::-webkit-scrollbar {
  width: 4px;
}

.panel-messages::-webkit-scrollbar-track {
  background: transparent;
}

.panel-messages::-webkit-scrollbar-thumb {
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-full);
}

@media (max-width: 767px) {
  .panel-main {
    width: calc(100vw - 48px);
  }
}
</style>
