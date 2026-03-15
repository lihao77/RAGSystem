<template>
  <div class="floating-chat-panel" :class="{ collapsed: isCollapsed }">
    <!-- 收起状态：小圆形按钮 -->
    <button v-if="isCollapsed" class="chat-toggle-btn" @click="isCollapsed = false" title="展开对话面板">
      <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path></svg>
      <span v-if="unreadCount > 0" class="unread-badge">{{ unreadCount }}</span>
    </button>

    <!-- 展开状态：完整面板 -->
    <div v-else class="panel-expanded">
      <div class="panel-header">
        <span class="panel-title">智能对话</span>
        <div class="panel-actions">
          <button class="panel-btn" @click="$emit('close')" title="返回聊天">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"></polyline></svg>
            <span>返回</span>
          </button>
          <button class="panel-btn" @click="isCollapsed = true" title="收起面板">
            <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"></polyline></svg>
          </button>
        </div>
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
        <textarea
          ref="inputRef"
          v-model="inputText"
          @keydown.enter.exact.prevent="sendMessage"
          placeholder="输入消息..."
          rows="1"
        ></textarea>
        <button class="send-btn" @click="sendMessage" :disabled="!inputText.trim() || isStreaming">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>
        </button>
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

const emit = defineEmits(['send-message', 'close']);

const isCollapsed = ref(false);
const inputText = ref('');
const messagesContainer = ref(null);
const inputRef = ref(null);
const unreadCount = ref(0);

const renderContent = (content) => {
  if (!content) return '';
  // 简化渲染：将 [viz:xxx] 替换为可点击链接文字
  const vizRe = /\[viz:(viz_\w+)\]/g;
  let rendered = content.replace(vizRe, '<span class="viz-link">[ 地图可视化 ]</span>');
  // 基本 markdown 处理
  rendered = rendered.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  rendered = rendered.replace(/\n/g, '<br/>');
  return rendered;
};

const sendMessage = () => {
  const text = inputText.value.trim();
  if (!text || props.isStreaming) return;
  emit('send-message', text);
  inputText.value = '';
};

// 监听 prefillText
watch(() => props.prefillText, (val) => {
  if (val) {
    inputText.value = val;
    isCollapsed.value = false;
    nextTick(() => inputRef.value?.focus());
  }
});

// 自动滚动到底部
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

// 展开时清除未读计数
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
  right: 16px;
  top: 64px;
  bottom: 16px;
  z-index: 10002;
  display: flex;
  flex-direction: column;
}

.floating-chat-panel.collapsed {
  top: auto;
  bottom: 24px;
  right: 24px;
}

.chat-toggle-btn {
  width: 52px;
  height: 52px;
  border-radius: 50%;
  background: rgba(33, 150, 243, 0.9);
  border: 2px solid rgba(255, 255, 255, 0.2);
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  transition: all 0.3s;
  position: relative;
}

.chat-toggle-btn:hover {
  transform: scale(1.1);
  box-shadow: 0 6px 28px rgba(33, 150, 243, 0.4);
}

.unread-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  background: #f44336;
  color: #fff;
  font-size: 0.65rem;
  font-weight: bold;
  min-width: 18px;
  height: 18px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 4px;
}

.panel-expanded {
  width: 380px;
  height: 100%;
  background: rgba(20, 20, 30, 0.92);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  animation: slideIn 0.3s ease-out;
}

@keyframes slideIn {
  from { transform: translateX(100%); opacity: 0; }
  to { transform: translateX(0); opacity: 1; }
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.panel-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.panel-actions {
  display: flex;
  gap: 4px;
}

.panel-btn {
  display: flex;
  align-items: center;
  gap: 3px;
  padding: 4px 10px;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  color: rgba(255, 255, 255, 0.7);
  cursor: pointer;
  font-size: 0.75rem;
  transition: all 0.2s;
}

.panel-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: #fff;
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
}

.chat-msg.user {
  justify-content: flex-end;
}

.msg-bubble {
  max-width: 85%;
  padding: 8px 12px;
  border-radius: 10px;
  font-size: 0.82rem;
  line-height: 1.5;
}

.chat-msg.user .msg-bubble {
  background: rgba(33, 150, 243, 0.3);
  color: #fff;
  border-bottom-right-radius: 3px;
}

.chat-msg.assistant .msg-bubble {
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.85);
  border-bottom-left-radius: 3px;
}

.msg-content {
  word-break: break-word;
}

:deep(.viz-link) {
  color: #64b5f6;
  cursor: default;
  font-style: italic;
  font-size: 0.78rem;
}

.streaming-indicator {
  display: flex;
  gap: 4px;
  padding: 8px 12px;
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.4);
  animation: dotPulse 1.2s infinite ease-in-out;
}

.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }

@keyframes dotPulse {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1); }
}

.panel-input {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 12px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.panel-input textarea {
  flex: 1;
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 8px 12px;
  color: #fff;
  font-size: 0.82rem;
  resize: none;
  outline: none;
  min-height: 36px;
  max-height: 100px;
  font-family: inherit;
}

.panel-input textarea::placeholder {
  color: rgba(255, 255, 255, 0.3);
}

.panel-input textarea:focus {
  border-color: rgba(33, 150, 243, 0.5);
}

.send-btn {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: rgba(33, 150, 243, 0.8);
  border: none;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s;
}

.send-btn:hover:not(:disabled) {
  background: rgba(33, 150, 243, 1);
}

.send-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 滚动条 */
.panel-messages::-webkit-scrollbar {
  width: 4px;
}

.panel-messages::-webkit-scrollbar-track {
  background: transparent;
}

.panel-messages::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.15);
  border-radius: 2px;
}

@media (max-width: 768px) {
  .panel-expanded {
    width: calc(100vw - 32px);
  }
}
</style>
