<template>
  <div class="app-layout">
    <!-- Sidebar -->
    <aside class="sidebar">
      <div class="sidebar-header">
        <button class="new-chat-btn" @click="startNewChat">
          <span class="icon">+</span>
          <span>New Chat</span>
        </button>
      </div>

      <div class="history-list">
        <div class="history-label">Recent</div>
        <div
          v-for="(item, index) in history"
          :key="index"
          class="history-item"
        >
          <span class="history-icon">💬</span>
          <span class="history-title">{{ item.title || 'New Conversation' }}</span>
        </div>
      </div>

      <div class="user-profile">
        <div class="avatar">U</div>
        <div class="user-info">
          <div class="username">User</div>
          <div class="user-status">Pro Plan</div>
        </div>
      </div>
    </aside>

    <!-- Main Chat Area -->
    <main class="chat-main" :class="{ 'has-messages': messages.length > 0 }">
      <div class="chat-messages" ref="messagesRef" @scroll="handleScroll">
        <!-- Welcome Screen -->
        <div v-if="messages.length === 0" class="welcome-screen">
          <div class="welcome-content">
            <div class="welcome-header">
              <div class="logo-placeholder">🧠</div>
              <h1>RAG Agent System</h1>
              <p class="welcome-subtitle">Advanced Knowledge Graph Analysis & Reasoning</p>
            </div>

          </div>
        </div>

        <!-- Message Stream -->
        <div v-else class="message-stream">
          <div v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]">
            <div class="message-content-wrapper">
              <div class="message-content">
                <!-- Loading State -->
                <div v-if="msg.role === 'assistant' && !msg.content && !msg.taskAnalysis && (!msg.subtasks || msg.subtasks.length === 0)" class="loading-indicator">
                  <div class="dot"></div><div class="dot"></div><div class="dot"></div>
                </div>

                <!-- Task Analysis -->
                <TaskAnalysisCard
                  v-if="msg.taskAnalysis"
                  :taskAnalysis="msg.taskAnalysis"
                  @update:expanded="msg.taskAnalysis.expanded = $event"
                />

                <!-- Subtasks -->
                <div v-if="msg.subtasks && msg.subtasks.length > 0" class="subtasks-list">
                  <SubtaskCard
                    v-for="subtask in msg.subtasks"
                    :key="subtask.order"
                    :subtask="subtask"
                    @update:expanded="subtask.expanded = $event"
                  />
                </div>

                <!-- Multimodal Content -->
                <MultimodalContent
                  v-if="msg.multimodalContents && msg.multimodalContents.length > 0"
                  :contents="msg.multimodalContents"
                />

                <!-- Final Answer -->
                <div v-if="msg.role === 'assistant' && msg.content && msg.content.trim()" class="final-answer">
                  <div class="markdown-body" v-html="renderMarkdown(msg.content)"></div>
                </div>

                <!-- User Message -->
                <div v-if="msg.role === 'user' && msg.content" class="user-text">
                  {{ msg.content }}
                </div>

                <!-- Status Updates -->
                <div v-if="msg.status && msg.status.length > 0" class="status-updates">
                  <div v-for="(status, sIndex) in msg.status" :key="sIndex" class="status-tag" :class="status.type">
                    <span v-if="status.type === 'error'" class="status-icon">⚠️</span>
                    {{ status.content }}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="input-area-wrapper" :class="{ 'centered': messages.length === 0 }">
        <ChatInput
          v-model="inputMessage"
          :isLoading="isLoading"
          @send="handleSend"
        />
      </div>
    </main>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, watch } from 'vue';
import axios from 'axios';
import { marked } from 'marked';
import SubtaskCard from './components/SubtaskCard.vue';
import TaskAnalysisCard from './components/TaskAnalysisCard.vue';
import ChatInput from './components/ChatInput.vue';
import MultimodalContent from './components/MultimodalContent.vue';

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const messagesRef = ref(null);
const history = ref([]);
const typewriterTimers = ref(new Map());
const isUserAtBottom = ref(true);

const startNewChat = () => {
  messages.value = [];
  inputMessage.value = '';
  typewriterTimers.value.forEach(timer => clearTimeout(timer));
  typewriterTimers.value.clear();
  isUserAtBottom.value = true;
};

// ... (Rest of logic remains same, just copying helper functions) ...

const typewriter = (target, key, text, speed = 30, timerId = null) => {
  if (timerId && typewriterTimers.value.has(timerId)) {
    clearTimeout(typewriterTimers.value.get(timerId));
    typewriterTimers.value.delete(timerId);
  }

  let currentIndex = 0;
  const originalText = target[key] || '';

  if (speed === 0) {
    target[key] = originalText + text;
    scrollToBottom();
    return;
  }

  const type = () => {
    if (currentIndex < text.length) {
      const displayText = originalText + text.substring(0, currentIndex + 1);
      target[key] = displayText;
      currentIndex++;
      const timer = setTimeout(type, speed);
      if (timerId) typewriterTimers.value.set(timerId, timer);
      scrollToBottom();
    } else {
      if (timerId) typewriterTimers.value.delete(timerId);
    }
  };
  type();
};

const renderMarkdown = (text) => marked.parse(text || '');

const checkIfAtBottom = () => {
  if (!messagesRef.value) return true;
  const container = messagesRef.value;
  return container.scrollHeight - container.scrollTop - container.clientHeight < 100;
};

const scrollToBottom = async (force = false) => {
  await nextTick();
  if (!messagesRef.value) return;
  if (force || isUserAtBottom.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight;
  }
};

const handleScroll = () => {
  isUserAtBottom.value = checkIfAtBottom();
};

const handleSend = async () => {
  const content = inputMessage.value.trim();
  if (!content || isLoading.value) return;

  messages.value.push({ role: 'user', content: content });
  inputMessage.value = '';
  isUserAtBottom.value = true;
  scrollToBottom(true);

  const assistantMsgIndex = messages.value.push({
    role: 'assistant',
    content: '',
    taskAnalysis: null,
    subtasks: [],
    multimodalContents: [],
    status: []
  }) - 1;

  isLoading.value = true;

  try {
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: content, session_id: null })
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

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
              const content = data.content;
              if (content.length <= 10 && currentMsg.content.length > 0) {
                currentMsg.content += content;
              } else {
                typewriter(currentMsg, 'content', content, 15, `msg-${assistantMsgIndex}-content`);
              }
            } else if (data.type === 'task_analysis') {
              currentMsg.taskAnalysis = {
                complexity: data.complexity,
                subtask_count: data.subtask_count,
                reasoning: data.reasoning,
                expanded: true
              };
            } else if (data.type === 'subtask_start') {
              if (currentMsg.subtasks.length > 0) {
                currentMsg.subtasks.forEach(st => st.expanded = false);
              }
              currentMsg.subtasks.push({
                order: data.order,
                agent_name: data.agent_name,
                agent_display_name: data.agent_display_name,
                description: data.description,
                react_steps: [],
                tool_calls: [],
                result_summary: '',
                status: 'running',
                expanded: true,
                currentStep: null
              });
            } else if (data.type === 'thought_structured') {
              const subtask = currentMsg.subtasks.find(s => s.order === data.subtask_order);
              if (subtask) {
                const newStep = {
                  round: data.round,
                  thought: data.thought,
                  toolCalls: [],
                  expanded: true
                };
                subtask.react_steps.push(newStep);
                subtask.currentStep = newStep;
              }
            } else if (data.type === 'tool_start') {
              const subtask = currentMsg.subtasks.find(s => s.order === data.subtask_order);
              if (subtask && subtask.currentStep) {
                const toolCall = {
                  tool_name: data.tool_name,
                  arguments: data.arguments,
                  status: 'running',
                  index: data.index,
                  total: data.total,
                  showResult: false,
                  showArgs: false
                };
                subtask.currentStep.toolCalls.push(toolCall);
                subtask.tool_calls.push(toolCall); // Compatibility
              }
            } else if (data.type === 'tool_end') {
              const subtask = currentMsg.subtasks.find(s => s.order === data.subtask_order);
              if (subtask && subtask.currentStep) {
                const updateTool = (list) => {
                  const idx = list.findIndex(t => t.tool_name === data.tool_name && t.status === 'running');
                  if (idx >= 0) {
                    list[idx].status = 'success';
                    list[idx].result = data.result;
                    list[idx].elapsed_time = data.elapsed_time;
                  }
                };
                updateTool(subtask.currentStep.toolCalls);
                updateTool(subtask.tool_calls);
              }
            } else if (data.type === 'subtask_end') {
              const subtask = currentMsg.subtasks.find(s => s.order === data.order);
              if (subtask) {
                subtask.result_summary = data.result_summary;
                subtask.status = data.success === false ? 'error' : 'success';
                if (currentMsg.subtasks.length > 1) subtask.expanded = false;
              }
            } else if (data.type === 'chart_generated') {
              currentMsg.multimodalContents.push({
                type: 'chart',
                echartsConfig: data.echarts_config,
                title: data.title || 'Data Visualization',
                chartType: data.chart_type || 'bar'
              });
            } else if (data.type === 'map_generated') {
              currentMsg.multimodalContents.push({
                type: 'map',
                mapData: data.mapData,
                title: data.title || 'Map Visualization'
              });
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
    messages.value[assistantMsgIndex].content += '\n\n[System Error: Request failed]';
  } finally {
    isLoading.value = false;
    scrollToBottom();
  }
};

onMounted(() => {
  isUserAtBottom.value = true;
});
</script>

<style scoped>
.app-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  background-color: transparent;
  overflow: hidden;
}

/* Sidebar */
.sidebar {
  width: 280px;
  background: rgba(255, 255, 255, 0.6);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  border-right: 1px solid rgba(255, 255, 255, 0.5);
  display: flex;
  flex-direction: column;
  padding: var(--spacing-md);
  flex-shrink: 0;
  box-shadow: 2px 0 20px rgba(0, 0, 0, 0.02);
}

.new-chat-btn {
  width: 100%;
  padding: var(--spacing-sm) var(--spacing-md);
  background: linear-gradient(135deg, var(--color-primary), #4f46e5);
  color: white;
  border: none;
  border-radius: var(--radius-md);
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-sm);
  cursor: pointer;
  transition: all var(--transition-fast);
  box-shadow: 0 4px 12px rgba(99, 102, 241, 0.25);
}

.new-chat-btn:hover {
  transform: translateY(-1px);
  box-shadow: 0 6px 16px rgba(99, 102, 241, 0.35);
}

.history-list {
  flex: 1;
  overflow-y: auto;
  margin: var(--spacing-lg) 0;
  padding-right: var(--spacing-xs);
}

.history-label {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin-bottom: var(--spacing-sm);
  letter-spacing: 0.05em;
  padding-left: var(--spacing-xs);
}

.history-item {
  padding: var(--spacing-sm) var(--spacing-md);
  margin-bottom: var(--spacing-xs);
  border-radius: var(--radius-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  color: var(--color-text-secondary);
  transition: all var(--transition-fast);
  font-size: 0.9rem;
  border: 1px solid transparent;
}

.history-item:hover {
  background-color: rgba(255, 255, 255, 0.5);
  color: var(--color-text-main);
  border-color: rgba(255, 255, 255, 0.8);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.02);
}

.history-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.user-profile {
  padding-top: var(--spacing-md);
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
}

.avatar {
  width: 36px;
  height: 36px;
  background: linear-gradient(135deg, var(--color-primary), #818cf8);
  color: white;
  border-radius: var(--radius-full);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 600;
  font-size: 0.9rem;
}

.user-info {
  flex: 1;
}

.username {
  font-weight: 500;
  font-size: 0.9rem;
  color: var(--color-text-main);
}

.user-status {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

/* Chat Main */
.chat-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  position: relative;
  min-width: 0;
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: var(--spacing-xl);
  scroll-behavior: smooth;
  /* Add padding to bottom to avoid content being hidden behind input */
  padding-bottom: 180px;
}

.welcome-screen {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  /* Push welcome content up slightly to make room for centered input */
  padding-bottom: 140px;
}

.welcome-content {
  max-width: 600px;
  display: flex;
  flex-direction: column;
  /* Space out header from input area from suggestions */
  gap: 120px;
}

.welcome-header {
  margin-bottom: 20px;
}


.logo-placeholder {
  font-size: 4rem;
  margin-bottom: var(--spacing-md);
  opacity: 0.8;
}

.welcome-screen h1 {
  font-size: 2rem;
  color: var(--color-text-main);
  margin-bottom: var(--spacing-sm);
  font-weight: 700;
  letter-spacing: -0.025em;
}

.welcome-subtitle {
  font-size: 1.1rem;
  color: var(--color-text-secondary);
}


/* Messages */
.message-stream {
  max-width: 800px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-xl);
}

.message {
  display: flex;
  gap: var(--spacing-md);
  opacity: 0;
  animation: fadeIn 0.3s ease forwards;
  width: 100%;
}

.message.user {
  justify-content: flex-end;
}

.message.assistant {
  justify-content: flex-start;
}

@keyframes fadeIn {
  to { opacity: 1; }
}

.message-content-wrapper {
  max-width: 85%;
  min-width: 0;
}

.message-content {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

.user-text {
  background-color: var(--color-bg-message-user);
  padding: 10px 16px;
  border-radius: 20px;
  border-top-right-radius: 4px; /* Optional: OpenAI-like small corner */
  color: var(--color-text-main);
  line-height: 1.6;
  font-size: 1rem;
}

/* Final Answer */
.final-answer {
  background-color: transparent;
  border: none;
  padding: 0;
  box-shadow: none;
}

.markdown-body {
  color: var(--color-text-main);
  font-size: 1rem;
  line-height: 1.6;
}

.markdown-body :deep(h1),
.markdown-body :deep(h2) {
  font-size: 1.25rem;
  font-weight: 600;
  margin-top: 1.5em;
  margin-bottom: 0.5em;
  color: var(--color-text-main);
}

.markdown-body :deep(p) {
  margin-bottom: 1em;
}

.markdown-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  background-color: var(--color-bg-app);
  padding: 0.2em 0.4em;
  border-radius: 4px;
}

/* Loading Dots */
.loading-indicator {
  display: flex;
  gap: 4px;
  padding: var(--spacing-sm);
}

.dot {
  width: 6px;
  height: 6px;
  background-color: var(--color-text-muted);
  border-radius: 50%;
  animation: bounce 1.4s infinite ease-in-out both;
}

.dot:nth-child(1) { animation-delay: -0.32s; }
.dot:nth-child(2) { animation-delay: -0.16s; }

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

.subtasks-list{
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}

/* Status Updates */
.status-updates {
  display: flex;
  flex-wrap: wrap;
  gap: var(--spacing-sm);
  margin-top: var(--spacing-sm);
}

.status-tag {
  font-size: 0.75rem;
  padding: 2px 8px;
  border-radius: var(--radius-full);
  background-color: var(--color-bg-app);
  color: var(--color-text-secondary);
  border: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  gap: 4px;
}

.status-tag.error {
  background-color: var(--color-error-bg);
  color: var(--color-error);
  border-color: #fca5a5;
}

/* Input Area Wrapper */
.input-area-wrapper {
  background: linear-gradient(to bottom, transparent 0%, var(--color-bg-app) 40%);
  border-top: none;
  backdrop-filter: none;
  padding: 60px var(--spacing-xl) var(--spacing-lg);
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  z-index: 10;
  transition: all 0.4s cubic-bezier(0.25, 0.8, 0.25, 1);
  display: flex;
  justify-content: center;
  pointer-events: none; /* Allow clicks to pass through the gradient area */
}

.input-area-wrapper > * {
  pointer-events: auto; /* Re-enable clicks on the input component itself */
  width: 100%;
}

.input-area-wrapper.centered {
  bottom: 50%;
  transform: translateY(50%);
  background: none;
  padding: 0 var(--spacing-xl);
  pointer-events: none; /* Wrapper is still transparent/ghostly */
}

.input-area-wrapper.centered > * {
  pointer-events: auto;
}
</style>