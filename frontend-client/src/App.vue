<template>
  <div class="chat-container">
    <div class="chat-sidebar">
      <div class="new-chat-btn" @click="startNewChat">
        <span>+ 新对话</span>
      </div>
      <div class="history-list">
        <div class="history-item" v-for="(item, index) in history" :key="index">
          {{ item.title || '新对话' }}
        </div>
      </div>
      <div class="user-profile">
        <div class="avatar">U</div>
        <div class="username">User</div>
      </div>
    </div>

    <div class="chat-main">
      <div class="chat-messages" ref="messagesRef">
        <div v-if="messages.length === 0" class="welcome-screen">
          <h1>多智能体系统</h1>
          <p class="welcome-subtitle">开始对话，探索知识图谱</p>
        </div>

        <div v-else v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]">
          <div class="message-avatar">
            {{ msg.role === 'user' ? 'U' : 'AI' }}
          </div>
          <div class="message-content">
            <div class="message-text" v-html="renderMarkdown(msg.content)"></div>

            <!-- 状态更新显示（不包括 thought，thought 在下方单独显示） -->
            <div v-if="msg.status && msg.status.length > 0" class="status-updates">
              <div v-for="(status, sIndex) in msg.status" :key="sIndex" class="status-item">
                <div v-if="status.type === 'agent_start'" class="status-agent-start">
                  <span class="status-icon">🤖</span>
                  <span class="status-text">{{ status.content }}</span>
                </div>
                <div v-else-if="status.type === 'error'" class="status-error">
                  <span class="status-icon">❌</span>
                  <span class="status-text">{{ status.content }}</span>
                </div>
              </div>
            </div>

            <div v-if="msg.thinking" class="thinking-process">
              <div class="thinking-header" @click="msg.showThinking = !msg.showThinking">
                <span class="icon">{{ msg.showThinking ? '▼' : '▶' }}</span>
                思考过程
              </div>
              <div v-if="msg.showThinking" class="thinking-content">
                {{ msg.thinking }}
              </div>
            </div>
          </div>
        </div>

        <div v-if="isLoading" class="message assistant">
          <div class="message-avatar">AI</div>
          <div class="message-content">
            <div class="loading-dots">
              <span>.</span><span>.</span><span>.</span>
            </div>
          </div>
        </div>
      </div>

      <div class="chat-input-area">
        <div class="input-wrapper">
          <textarea
            v-model="inputMessage"
            @keydown.enter.prevent="handleEnter"
            placeholder="输入您的问题..."
            rows="1"
            ref="textareaRef"
          ></textarea>
          <button :disabled="!inputMessage.trim() || isLoading" @click="handleSend">
            发送
          </button>
        </div>
        <div class="disclaimer">
          AI 可能会生成不准确的信息，请核实重要信息。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, watch } from 'vue';
import axios from 'axios';
import { marked } from 'marked';

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const messagesRef = ref(null);
const textareaRef = ref(null);
const history = ref([]);

const startNewChat = () => {
  messages.value = [];
  inputMessage.value = '';
};

const renderMarkdown = (text) => {
  return marked.parse(text || '');
};

const scrollToBottom = async () => {
  await nextTick();
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
  }
};

const adjustTextareaHeight = () => {
  const el = textareaRef.value;
  if (el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
  }
};

watch(inputMessage, adjustTextareaHeight);

const handleEnter = (e) => {
  if (!e.shiftKey) {
    handleSend();
  }
};

const sendMessage = (text) => {
  inputMessage.value = text;
  handleSend();
};

const handleSend = async () => {
  const content = inputMessage.value.trim();
  if (!content || isLoading.value) return;

  // Add user message
  messages.value.push({
    role: 'user',
    content: content
  });

  inputMessage.value = '';
  if (textareaRef.value) textareaRef.value.style.height = 'auto';
  scrollToBottom();

  // Create empty assistant message
  const assistantMsgIndex = messages.value.push({
    role: 'assistant',
    content: '',
    thinking: '',
    status: [], // 存储状态更新事件
    showThinking: true
  }) - 1;

  isLoading.value = true; // 保持 loading 状态直到完成，但因为有了空消息，实际上不会显示 loading dots

  try {
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        task: content,
        session_id: null // 可选：如果需要会话记忆
      })
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value);
      const lines = chunk.split('\n\n');

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.substring(6));
            const currentMsg = messages.value[assistantMsgIndex];

            if (data.type === 'chunk') {
              currentMsg.content += data.content;
            } else if (data.type === 'thought') {
              // currentMsg.status.push({ type: 'thought', content: data.content });
              currentMsg.thinking += data.content + '\n';
            } else if (data.type === 'agent_start') {
              currentMsg.status.push({ type: 'agent_start', content: data.content });
            } else if (data.type === 'agent_end') {
              // 可选：添加结束状态
            } else if (data.type === 'error') {
              currentMsg.status.push({ type: 'error', content: data.content });
            }

            scrollToBottom();
          } catch (e) {
            console.error('Error parsing SSE data:', e);
          }
        }
      }
    }
  } catch (error) {
    console.error('Error sending message:', error);
    messages.value[assistantMsgIndex].content += '\n\n[系统错误: 请求失败，请稍后再试]';
  } finally {
    isLoading.value = false;
    scrollToBottom();
  }
};
</script>

<style scoped>
/* 扁平化简约设计 */
.chat-container {
  display: flex;
  height: 100vh;
  width: 100%;
  background-color: #fafafa;
  color: #2c3e50;
}

/* 侧边栏 - 极简黑白 */
.chat-sidebar {
  width: 260px;
  background-color: #1a1a1a;
  color: #e0e0e0;
  display: flex;
  flex-direction: column;
  padding: 16px;
  border-right: 1px solid #2a2a2a;
}

.new-chat-btn {
  background-color: transparent;
  border: 1px solid #404040;
  border-radius: 8px;
  padding: 12px 16px;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-bottom: 24px;
  text-align: left;
  font-size: 14px;
  color: #e0e0e0;
}

.new-chat-btn:hover {
  background-color: #2a2a2a;
  border-color: #505050;
}

.history-list {
  flex: 1;
  overflow-y: auto;
  margin-bottom: 16px;
}

.history-item {
  padding: 10px 12px;
  cursor: pointer;
  border-radius: 6px;
  margin-bottom: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 14px;
  color: #b0b0b0;
  transition: all 0.2s ease;
}

.history-item:hover {
  background-color: #2a2a2a;
  color: #e0e0e0;
}

.user-profile {
  padding: 16px 12px;
  border-top: 1px solid #2a2a2a;
  display: flex;
  align-items: center;
  gap: 12px;
}

.avatar {
  width: 32px;
  height: 32px;
  background-color: #3a3a3a;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #e0e0e0;
  font-weight: 500;
  font-size: 14px;
}

.username {
  font-size: 14px;
  color: #b0b0b0;
}

/* 主聊天区域 - 纯白简洁 */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  background-color: #ffffff;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 32px 24px;
  padding-bottom: 180px;
}

/* 欢迎屏幕 - 大留白 */
.welcome-screen {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 16px;
}

.welcome-screen h1 {
  font-size: 36px;
  font-weight: 300;
  color: #1a1a1a;
  margin: 0;
  letter-spacing: -0.5px;
}

.welcome-subtitle {
  font-size: 15px;
  font-weight: 400;
  color: #718096;
  margin: 0;
}

/* 消息 - 扁平卡片 */
.message {
  display: flex;
  gap: 16px;
  padding: 24px 0;
  max-width: 900px;
  margin: 0 auto;
  width: 100%;
}

.message.user {
  background-color: transparent;
}

.message.assistant {
  background-color: transparent;
}

.message-avatar {
  width: 40px;
  height: 40px;
  min-width: 40px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 500;
  font-size: 16px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.06);
}

.message.user .message-avatar {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.message.assistant .message-avatar {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
}

.message-content {
  flex: 1;
  line-height: 1.7;
  font-size: 15px;
  color: #2c3e50;
}

.message-text {
  margin-bottom: 12px;
}

/* 状态更新 - 极简标签 */
.status-updates {
  margin-bottom: 16px;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.status-item {
  padding: 6px 12px;
  border-radius: 16px;
  background-color: #f5f5f5;
  border: none;
  font-size: 13px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-agent-start {
  color: #5a67d8;
}

.status-error {
  color: #e53e3e;
  background-color: #fff5f5;
}

.status-icon {
  font-size: 14px;
}

/* 思考过程 - 扁平折叠 */
.thinking-process {
  margin-top: 16px;
  border: 1px solid #e8e8e8;
  border-radius: 8px;
  overflow: hidden;
  background-color: #fafafa;
}

.thinking-header {
  background-color: transparent;
  padding: 12px 16px;
  font-size: 13px;
  color: #718096;
  cursor: pointer;
  user-select: none;
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 500;
  transition: color 0.2s ease;
}

.thinking-header:hover {
  color: #4a5568;
}

.thinking-header .icon {
  font-size: 10px;
  transition: transform 0.2s ease;
}

.thinking-content {
  padding: 16px;
  background-color: #ffffff;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
  font-size: 13px;
  color: #4a5568;
  white-space: pre-wrap;
  line-height: 1.6;
  border-top: 1px solid #e8e8e8;
}

/* 输入区域 - 极简悬浮 */
.chat-input-area {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 24px;
  background: linear-gradient(to top, #ffffff 70%, rgba(255, 255, 255, 0));
  pointer-events: none;
}

.input-wrapper {
  max-width: 900px;
  margin: 0 auto;
  position: relative;
  border: 1px solid #e0e0e0;
  border-radius: 12px;
  background-color: #ffffff;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: flex-end;
  padding: 12px;
  pointer-events: auto;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.input-wrapper:focus-within {
  border-color: #667eea;
  box-shadow: 0 4px 20px rgba(102, 126, 234, 0.15);
}

textarea {
  flex: 1;
  border: none;
  resize: none;
  padding: 8px 12px;
  font-family: inherit;
  font-size: 15px;
  max-height: 200px;
  outline: none;
  color: #2c3e50;
  line-height: 1.5;
}

textarea::placeholder {
  color: #a0aec0;
}

button {
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  align-self: flex-end;
  transition: all 0.2s ease;
  box-shadow: 0 2px 8px rgba(102, 126, 234, 0.3);
}

button:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
}

button:disabled {
  background: #e2e8f0;
  cursor: not-allowed;
  box-shadow: none;
  transform: none;
}

.disclaimer {
  text-align: center;
  font-size: 12px;
  color: #a0aec0;
  margin-top: 12px;
  font-weight: 400;
}

/* Loading 动画 - 简约点 */
.loading-dots {
  display: flex;
  gap: 4px;
}

.loading-dots span {
  width: 8px;
  height: 8px;
  background-color: #cbd5e0;
  border-radius: 50%;
  animation: loading 1.4s infinite ease-in-out both;
}

.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
.loading-dots span:nth-child(2) { animation-delay: -0.16s; }
.loading-dots span:nth-child(3) { animation-delay: 0s; }

@keyframes loading {
  0%, 80%, 100% {
    transform: scale(0.8);
    opacity: 0.5;
  }
  40% {
    transform: scale(1.1);
    opacity: 1;
  }
}

/* Markdown 样式优化 */
.message-content :deep(h1),
.message-content :deep(h2),
.message-content :deep(h3) {
  margin-top: 24px;
  margin-bottom: 16px;
  font-weight: 600;
  line-height: 1.3;
}

.message-content :deep(h1) { font-size: 24px; }
.message-content :deep(h2) { font-size: 20px; }
.message-content :deep(h3) { font-size: 17px; }

.message-content :deep(p) {
  margin-bottom: 12px;
}

.message-content :deep(code) {
  background-color: #f5f5f5;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 0.9em;
  font-family: 'SF Mono', 'Monaco', 'Consolas', monospace;
}

.message-content :deep(pre) {
  background-color: #f5f5f5;
  padding: 16px;
  border-radius: 8px;
  overflow-x: auto;
  margin: 16px 0;
}

.message-content :deep(pre code) {
  background-color: transparent;
  padding: 0;
}

.message-content :deep(ul),
.message-content :deep(ol) {
  padding-left: 24px;
  margin-bottom: 12px;
}

.message-content :deep(li) {
  margin-bottom: 4px;
}

/* 滚动条美化 */
.chat-messages::-webkit-scrollbar,
.history-list::-webkit-scrollbar {
  width: 6px;
}

.chat-messages::-webkit-scrollbar-track,
.history-list::-webkit-scrollbar-track {
  background: transparent;
}

.chat-messages::-webkit-scrollbar-thumb {
  background: #e0e0e0;
  border-radius: 3px;
}

.history-list::-webkit-scrollbar-thumb {
  background: #3a3a3a;
  border-radius: 3px;
}

.chat-messages::-webkit-scrollbar-thumb:hover {
  background: #d0d0d0;
}

.history-list::-webkit-scrollbar-thumb:hover {
  background: #4a4a4a;
}
</style>
