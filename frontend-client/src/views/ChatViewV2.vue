<template>
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
          <div class="user-status">Pro Plan · V2</div>
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
              <h1>RAG Agent System V2</h1>
              <p class="welcome-subtitle">Dynamic Agent Orchestration with ReAct Pattern</p>
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
                  <!-- Status Ticker (同 V1) -->
                  <SubtaskStatusTicker
                    :subtasks="msg.subtasks"
                    :expanded="msg.showFullSubtasks"
                    @toggle-view="msg.showFullSubtasks = !msg.showFullSubtasks"
                  />

                  <!-- Full View -->
                  <transition
                    name="expand"
                    @enter="enter"
                    @after-enter="afterEnter"
                    @leave="leave"
                  >
                    <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
                      <!-- 🎯 V2: 按轮次分组显示 -->
                      <div v-for="(roundGroup, roundNum) in groupSubtasksByRound(msg.subtasks)" :key="roundNum" class="round-group">
                        <div v-if="Object.keys(groupSubtasksByRound(msg.subtasks)).length > 1" class="round-header">
                          第 {{ roundNum }} 轮推理
                        </div>
                        <div class="subtasks-list">
                          <SubtaskCard
                            v-for="subtask in roundGroup"
                            :key="subtask.order"
                            :subtask="subtask"
                            @update:expanded="subtask.expanded = $event"
                          />
                        </div>
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

// 🎯 按轮次分组 subtasks
const groupSubtasksByRound = (subtasks) => {
  const groups = {};
  for (const subtask of subtasks) {
    const round = subtask.round || 1;  // 降级：没有 round 则默认为 1
    if (!groups[round]) {
      groups[round] = [];
    }
    groups[round].push(subtask);
  }
  return groups;
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
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: content,
        session_id: null,
        use_v2: true  // 🎯 关键：指定使用 Master V2
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

            // 🎯 Master V2 使用 subtask_start 代表 Agent 调用
            if (data.type === 'subtask_start') {
              // 折叠之前的 Agent 调用
              if (currentMsg.subtasks.length > 0) {
                currentMsg.subtasks.forEach(st => st.expanded = false);
              }

              currentMsg.subtasks.push({
                order: data.order,
                task_id: data.task_id,  // V2 新增：精确追踪
                round: data.round,  // 🎯 新增：第几轮推理
                round_index: data.round_index,  // 🎯 新增：轮次内索引
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
            }
            // 🎯 Master V2 的 thought 关联到 Agent 调用
            else if (data.type === 'thought_structured') {
              // 通过 task_id 或 subtask_order 定位 Agent
              const subtask = data.task_id
                ? currentMsg.subtasks.find(s => s.task_id === data.task_id)
                : currentMsg.subtasks.find(s => s.order === data.subtask_order);

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
            }
            // 工具调用（如果 Master V2 内部有 Agent 调用工具）
            else if (data.type === 'tool_start') {
              const subtask = currentMsg.subtasks.find(s => s.order === data.subtask_order || s.task_id === data.task_id);
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
            }
            else if (data.type === 'tool_end') {
              const subtask = currentMsg.subtasks.find(s => s.order === data.subtask_order || s.task_id === data.task_id);
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
            }
            // 🎯 Master V2 的 Agent 调用完成
            else if (data.type === 'subtask_end') {
              const subtask = currentMsg.subtasks.find(s => s.order === data.order || s.task_id === data.task_id);
              if (subtask) {
                subtask.result_summary = data.result_summary;
                subtask.status = data.success === false ? 'error' : 'success';
                subtask.expanded = false;
              }
            }
            // 最终答案（流式）
            else if (data.type === 'chunk') {
              const content = data.content;
              if (content.length <= 10 && currentMsg.content.length > 0) {
                currentMsg.content += content;
              } else {
                typewriter(currentMsg, 'content', content, 15, `msg-${assistantMsgIndex}-content`);
              }
            }
            // 最终答案（完整）
            else if (data.type === 'final_answer') {
              currentMsg.content = data.content;
            }
            // 图表生成
            else if (data.type === 'chart_generated') {
              currentMsg.multimodalContents.push({
                type: 'chart',
                echartsConfig: data.echarts_config,
                title: data.title || 'Data Visualization',
                chartType: data.chart_type || 'bar'
              });
            }
            // 地图生成
            else if (data.type === 'map_generated') {
              currentMsg.multimodalContents.push({
                type: 'map',
                mapData: data.mapData,
                title: data.title || 'Map Visualization'
              });
            }
            // 错误
            else if (data.type === 'error') {
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

<style scoped src="../styles/chat-view.css"></style>
