template>
  <div class="chat-view">
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
          <div class="user-status">Master V2</div>
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
              <div class="logo-placeholder">🤖</div>
              <h1>Master Agent V2</h1>
              <p class="welcome-subtitle">Dynamic Agent Orchestration with ReAct Pattern</p>
              <div class="v2-features">
                <div class="feature-badge">
                  <span class="badge-icon">🧠</span>
                  <span>Dynamic Planning</span>
                </div>
                <div class="feature-badge">
                  <span class="badge-icon">🔄</span>
                  <span>Real-time Adaptation</span>
                </div>
                <div class="feature-badge">
                  <span class="badge-icon">🎯</span>
                  <span>Agent-as-Tool</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- Message Stream -->
        <div v-else class="message-stream">
          <div v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]">
            <div class="message-content-wrapper">
              <div class="message-content">
                <!-- Loading State -->
                <div v-if="msg.role === 'assistant' && !msg.content && (!msg.subtasks || msg.subtasks.length === 0)" class="loading-indicator">
                  <div class="dot"></div><div class="dot"></div><div class="dot"></div>
                </div>

                <!-- Subtasks (Agent Calls) -->
                <div v-if="msg.subtasks && msg.subtasks.length > 0" class="subtasks-container">
                  <!-- Status Ticker (Header) -->
                  <SubtaskStatusTicker
                    :subtasks="msg.subtasks"
                    :expanded="msg.showFullSubtasks"
                    @toggle-view="msg.showFullSubtasks = !msg.showFullSubtasks"
                  />

                  <!-- Full Details View -->
                  <transition
                    name="expand"
                    @enter="enter"
                    @after-enter="afterEnter"
                    @leave="leave"
                  >
                    <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
                      <div class="subtasks-list">
                        <SubtaskCard
                          v-for="subtask in msg.subtasks"
                          :key="subtask.order"
                          :subtask="subtask"
                          @update:expanded="subtask.expanded = $event"
                        />
                      </div>
                    </div>
                  </transition>
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
import { ref, nextTick, onMounted } from 'vue';
import { renderMarkdown } from '../utils/markdown';
import SubtaskCard from '../components/SubtaskCard.vue';
import SubtaskStatusTicker from '../components/SubtaskStatusTicker.vue';
import ChatInput from '../components/ChatInput.vue';
import MultimodalContent from '../components/MultimodalContent.vue';

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

// Expand Animation Hooks
const enter = (el) => {
  el.style.height = '0';
  el.style.opacity = '0';
  el.offsetHeight;
  el.style.height = el.scrollHeight + 'px';
  el.style.opacity = '1';
};

const afterEnter = (el) => {
  el.style.height = 'auto';
  el.style.opacity = '';
};

const leave = (el) => {
  el.style.height = el.scrollHeight + 'px';
  el.style.opacity = '1';
  el.offsetHeight;
  el.style.height = '0';
  el.style.opacity = '0';
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
    subtasks: [],
    showFullSubtasks: false,
    multimodalContents: [],
    status: []
  }) - 1;

  isLoading.value = true;

  try {
    // 🔑 关键差异：use_v2 参数指定使用 Master V2
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: content,
        session_id: null,
        use_v2: true  // ✨ 使用 Master V2
      })
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
            } else if (data.type === 'subtask_start') {
              // Master V2 发送的 Agent 调用开始事件
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
              // Master V2 的思考过程（与 ReAct Agent 相同格式）
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
              // Agent 内部的工具调用
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
                subtask.tool_calls.push(toolCall);
              }
            } else if (data.type === 'tool_end') {
              // Agent 内部的工具完成
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
              // Master V2 的 Agent 调用结束
              const subtask = currentMsg.subtasks.find(s => s.order === data.order);
              if (subtask) {
                subtask.result_summary = data.result_summary;
                subtask.status = data.success === false ? 'error' : 'success';
                subtask.expanded = false;
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

<style scoped src="../styles/chat-view.css">
/* 继承 V1 的样式文件，保持风格一致 */
</style>

<style scoped>
/* V2 特定样式 */
.v2-features {
  display: flex;
  gap: var(--spacing-md);
  margin-top: var(--spacing-xl);
  justify-content: center;
  flex-wrap: wrap;
}

.feature-badge {
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  padding: var(--spacing-sm) var(--spacing-md);
  background: var(--glass-bg-light);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-full);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  transition: all var(--transition-normal);
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--color-text-secondary);
}

.feature-badge:hover {
  background: var(--color-bg-secondary);
  border-color: var(--color-primary);
  color: var(--color-text-primary);
  transform: translateY(-2px);
  box-shadow: var(--shadow-md);
}

.badge-icon {
  font-size: 1.2rem;
}

/* User status badge for V2 */
.user-status {
  font-size: 0.75rem;
  color: var(--color-primary);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
</style>