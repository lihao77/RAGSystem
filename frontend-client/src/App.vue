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
          <h1>RAGSystem AI 助手</h1>
          <div class="suggestions">
            <div class="suggestion-card" @click="sendMessage('查询最近的销售数据')">
              查询最近的销售数据
            </div>
            <div class="suggestion-card" @click="sendMessage('分析系统日志异常')">
              分析系统日志异常
            </div>
            <div class="suggestion-card" @click="sendMessage('知识图谱中实体关系查询')">
              知识图谱中实体关系查询
            </div>
          </div>
        </div>

        <div v-else v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]">
          <div class="message-avatar">
            {{ msg.role === 'user' ? 'U' : 'AI' }}
          </div>
          <div class="message-content">
            <div class="message-text" v-html="renderMarkdown(msg.content)"></div>

            <!-- 状态更新显示 -->
            <div v-if="msg.status && msg.status.length > 0" class="status-updates">
              <div v-for="(status, sIndex) in msg.status" :key="sIndex" class="status-item">
                <div v-if="status.type === 'agent_start'" class="status-agent-start">
                  <span class="status-icon">🤖</span>
                  <span class="status-text">{{ status.content }}</span>
                </div>
                <div v-else-if="status.type === 'thought'" class="status-thought">
                  <span class="status-icon">💭</span>
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
              currentMsg.status.push({ type: 'thought', content: data.content });
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
.chat-container {
  display: flex;
  height: 100vh;
  width: 100%;
  background-color: #fff;
  color: #333;
}

.chat-sidebar {
  width: 260px;
  background-color: #000;
  color: #fff;
  display: flex;
  flex-direction: column;
  padding: 10px;
}

.new-chat-btn {
  border: 1px solid #444;
  border-radius: 5px;
  padding: 10px;
  cursor: pointer;
  transition: background-color 0.2s;
  margin-bottom: 20px;
  text-align: left;
}

.new-chat-btn:hover {
  background-color: #222;
}

.history-list {
  flex: 1;
  overflow-y: auto;
}

.history-item {
  padding: 10px;
  cursor: pointer;
  border-radius: 5px;
  margin-bottom: 5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-item:hover {
  background-color: #222;
}

.user-profile {
  padding: 15px;
  border-top: 1px solid #333;
  display: flex;
  align-items: center;
  gap: 10px;
}

.avatar {
  width: 32px;
  height: 32px;
  background-color: #10a37f;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: white;
  font-weight: bold;
}

.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
  padding-bottom: 150px;
}

.welcome-screen {
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 40px;
}

.suggestions {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  max-width: 800px;
  width: 100%;
}

.suggestion-card {
  border: 1px solid #eee;
  padding: 15px;
  border-radius: 10px;
  cursor: pointer;
  background-color: #f9f9f9;
  text-align: center;
  transition: all 0.2s;
}

.suggestion-card:hover {
  background-color: #eee;
}

.message {
  display: flex;
  gap: 20px;
  padding: 20px;
  max-width: 800px;
  margin: 0 auto;
  border-bottom: 1px solid #f0f0f0;
}

.message.user {
  background-color: #fff;
}

.message.assistant {
  background-color: #f7f7f8;
}

.message-avatar {
  width: 36px;
  height: 36px;
  min-width: 36px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: bold;
}

.message.user .message-avatar {
  background-color: #8e44ad;
  color: white;
}

.message.assistant .message-avatar {
  background-color: #10a37f;
  color: white;
}

.message-content {
  flex: 1;
  line-height: 1.6;
}

.thinking-process {
  margin-top: 10px;
  border: 1px solid #eee;
  border-radius: 5px;
  overflow: hidden;
}

.thinking-header {
  background-color: #f5f5f5;
  padding: 8px 12px;
  font-size: 0.9em;
  color: #666;
  cursor: pointer;
  user-select: none;
}

.thinking-content {
  padding: 10px;
  background-color: #fafafa;
  font-family: monospace;
  font-size: 0.9em;
  color: #555;
  white-space: pre-wrap;
}

.status-updates {
  margin-bottom: 15px;
  font-size: 0.9em;
}

.status-item {
  margin-bottom: 5px;
  padding: 5px 10px;
  border-radius: 4px;
  background-color: #fff;
  border: 1px solid #eee;
  display: inline-block;
  margin-right: 5px;
}

.status-agent-start {
  color: #2c3e50;
}

.status-thought {
  color: #7f8c8d;
  font-style: italic;
}

.status-error {
  color: #e74c3c;
}

.status-icon {
  margin-right: 5px;
}

.chat-input-area {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  padding: 30px;
  background-image: linear-gradient(to top, #fff 80%, transparent);
}

.input-wrapper {
  max-width: 800px;
  margin: 0 auto;
  position: relative;
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  background-color: #fff;
  box-shadow: 0 0 10px rgba(0,0,0,0.05);
  display: flex;
  align-items: flex-end;
  padding: 10px;
}

textarea {
  flex: 1;
  border: none;
  resize: none;
  padding: 10px;
  font-family: inherit;
  font-size: 1em;
  max-height: 200px;
  outline: none;
}

button {
  background-color: #10a37f;
  color: white;
  border: none;
  padding: 8px 15px;
  border-radius: 6px;
  cursor: pointer;
  margin-left: 10px;
  font-size: 0.9em;
  align-self: flex-end;
}

button:disabled {
  background-color: #ccc;
  cursor: not-allowed;
}

.disclaimer {
  text-align: center;
  font-size: 0.8em;
  color: #999;
  margin-top: 10px;
}

.loading-dots span {
  animation: loading 1.4s infinite ease-in-out both;
  font-size: 1.5em;
  margin: 0 2px;
}

.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
.loading-dots span:nth-child(2) { animation-delay: -0.16s; }

@keyframes loading {
  0%, 80%, 100% { opacity: 0; }
  40% { opacity: 1; }
}
</style>
