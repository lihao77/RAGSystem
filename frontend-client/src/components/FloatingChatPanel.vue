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
          <button class="panel-collapse-btn" @click.stop="toggleCollapse(true)" title="收起">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>

        <div class="panel-messages" ref="messagesContainer">
          <div v-for="(msg, idx) in messages" :key="idx" class="chat-msg" :class="msg.role">
            <div class="msg-bubble">
              <div v-if="msg.role === 'user'" class="msg-content">{{ msg.content }}</div>
              <div v-else class="msg-content" v-html="renderContent(msg.content)"></div>
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
            <button class="send-btn" @click="sendMessage" :disabled="!inputText.trim() || isStreaming">
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                <path d="M3.478 2.405a.75.75 0 00-.926.94l2.432 7.905H13.5a.75.75 0 010 1.5H4.984l-2.432 7.905a.75.75 0 00.926.94 60.519 60.519 0 0018.445-8.986.75.75 0 000-1.218A60.517 60.517 0 003.478 2.405z" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, watch, nextTick } from 'vue';

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

const renderContent = (content) => {
  if (!content) return '';
  const vizRe = /\[viz:(viz_\w+)\]/g;
  let rendered = content.replace(vizRe, '<span class="viz-link">[ 地图可视化 ]</span>');
  rendered = rendered.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre class="chat-code-block"><code>$2</code></pre>');
  rendered = rendered.replace(/`([^`]+)`/g, '<code class="chat-inline-code">$1</code>');
  rendered = rendered.replace(/^### (.+)$/gm, '<div class="chat-h3">$1</div>');
  rendered = rendered.replace(/^## (.+)$/gm, '<div class="chat-h2">$1</div>');
  rendered = rendered.replace(/^# (.+)$/gm, '<div class="chat-h1">$1</div>');
  rendered = rendered.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  rendered = rendered.replace(/^[-*] (.+)$/gm, '<div class="chat-list-item">· $1</div>');
  rendered = rendered.replace(/^(\d+)\. (.+)$/gm, '<div class="chat-list-item">$1. $2</div>');
  rendered = rendered.replace(/\n{2,}/g, '<br/>');
  rendered = rendered.replace(/<\/(div|pre)>\n/g, '</$1>');
  rendered = rendered.replace(/\n<(div|pre)/g, '<$1');
  rendered = rendered.replace(/\n/g, '<br/>');
  return rendered;
};

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
  transition: transform 0.35s cubic-bezier(0.4, 0, 0.2, 1);
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

.panel-collapse-btn {
  width: 26px;
  height: 26px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--color-text-muted);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.panel-collapse-btn:hover {
  background: var(--color-hover-overlay);
  color: var(--color-text-secondary);
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

:deep(.chat-code-block) {
  background: var(--color-bg-secondary);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin: 4px 0;
  overflow-x: auto;
  font-size: var(--font-size-xs);
  line-height: 1.5;
}

:deep(.chat-code-block code) {
  font-family: var(--font-mono);
  color: var(--color-text-primary);
}

:deep(.chat-inline-code) {
  background: var(--color-hover-overlay-md);
  padding: 1px 5px;
  border-radius: 3px;
  font-family: var(--font-mono);
  font-size: var(--font-size-xs);
}

:deep(.chat-h1) { font-size: var(--font-size-base); font-weight: 700; margin: 6px 0 4px; }
:deep(.chat-h2) { font-size: var(--font-size-sm); font-weight: 700; margin: 5px 0 3px; }
:deep(.chat-h3) { font-size: var(--font-size-sm); font-weight: 600; margin: 4px 0 2px; }

:deep(.chat-list-item) {
  padding-left: 4px;
  line-height: 1.6;
}

:deep(.viz-link) {
  color: var(--color-link);
  cursor: default;
  font-style: italic;
  font-size: var(--font-size-xs);
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
  transition: all var(--transition-fast);
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

.send-btn {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-md);
  background: var(--color-bg-elevated);
  border: 1px solid var(--color-border);
  color: var(--color-text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all var(--transition-fast);
  margin-bottom: 2px;
  margin-right: 2px;
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

@media (max-width: 768px) {
  .panel-main {
    width: calc(100vw - 48px);
  }
}
</style>
