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
              <h1>RAG Agent System V2</h1>
              <p class="welcome-subtitle">Advanced Knowledge Graph Analysis with Parallel Execution</p>
              
            </div>
          </div>
        </div>

        <!-- Message Stream -->
        <div v-else class="message-stream">
          <div v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]">
            <div class="message-content-wrapper">
              <div class="message-content">
                <!-- Loading State -->
                <div v-if="msg.role === 'assistant' && !msg.content && !msg.taskAnalysis && !msg.executionPlan && (!msg.subtasks || msg.subtasks.length === 0)" class="loading-indicator">
                  <div class="dot"></div><div class="dot"></div><div class="dot"></div>
                </div>

                <!-- Task Analysis (V1 兼容) -->
                <TaskAnalysisCard
                  v-if="msg.taskAnalysis"
                  :taskAnalysis="msg.taskAnalysis"
                  @update:expanded="msg.taskAnalysis.expanded = $event"
                />

                <!-- Execution Plan (V2 新增) -->
                <ExecutionPlanCard
                  v-if="msg.executionPlan"
                  :plan="msg.executionPlan"
                />

                <!-- Parallel Status Panel (V2 新增 - 动态显示) -->
                <ParallelStatusPanel
                  v-if="hasParallelTasks(msg.subtasks)"
                  :subtasks="msg.subtasks"
                />

                <!-- Subtasks (V1 兼容 - 保留原有显示) -->
                <div v-if="msg.subtasks && msg.subtasks.length > 0" class="subtasks-container">
                  <SubtaskStatusTicker
                    :subtasks="msg.subtasks"
                    :expanded="msg.showFullSubtasks"
                    @toggle-view="msg.showFullSubtasks = !msg.showFullSubtasks"
                  />

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
import TaskAnalysisCard from '../components/TaskAnalysisCard.vue';
import ChatInput from '../components/ChatInput.vue';
import MultimodalContent from '../components/MultimodalContent.vue';
// V2 Components
import ExecutionPlanCard from '../components/ExecutionPlanCard.vue';
import ParallelStatusPanel from '../components/ParallelStatusPanel.vue';

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

// 判断是否有并行任务（用于自动显示并行面板）
const hasParallelTasks = (subtasks) => {
  if (!subtasks) return false;
  const running = subtasks.filter(t => t.status === 'running');
  return running.length > 1;
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

  // V2 消息结构
  const assistantMsgIndex = messages.value.push({
    role: 'assistant',
    content: '',
    taskAnalysis: null,        // V1 兼容
    executionPlan: null,       // ✨ V2 新增
    subtasks: [],
    showFullSubtasks: false,
    multimodalContents: [],
    status: []
  }) - 1;

  isLoading.value = true;

  try {
    // ✨ 明确使用 V2
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        task: content,
        session_id: null,
        use_v2: true  // ✨ 明确请求使用 V2
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
            }
            // V1 兼容事件
            else if (data.type === 'task_analysis') {
              currentMsg.taskAnalysis = {
                complexity: data.complexity,
                subtask_count: data.subtask_count,
                reasoning: data.reasoning,
                expanded: true
              };
            }
            // ✨ V2 新增事件：执行计划
            else if (data.type === 'plan') {
              currentMsg.executionPlan = data.plan;
            }
            // ✨ V2 新增事件：状态消息
            else if (data.type === 'status') {
              currentMsg.status.push({ type: 'info', content: data.content });
            }
            // 子任务开始
            else if (data.type === 'subtask_start') {
              console.log('[V2] subtask_start:', {
                task_id: data.task_id,
                order: data.order,
                agent_name: data.agent_name,
                description: data.description
              });

              if (currentMsg.subtasks.length > 0) {
                currentMsg.subtasks.forEach(st => st.expanded = false);
              }
              currentMsg.subtasks.push({
                task_id: data.task_id,      // ✨ V2 新增
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
            }
            else if (data.type === 'thought_structured') {
              console.log('[V2] thought_structured:', {
                subtask_order: data.subtask_order,
                task_id: data.task_id,
                round: data.round,
                thought_preview: data.thought?.substring(0, 50) + '...'
              });

              // ✅ 优先使用 task_id 查找（更可靠），降级到 order
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
              } else {
                console.warn('[V2] thought_structured: subtask not found for order', data.subtask_order, data);
              }
            }
            else if (data.type === 'tool_start') {
              console.log('[V2] tool_start:', {
                subtask_order: data.subtask_order,
                task_id: data.task_id,
                tool_name: data.tool_name,
                index: data.index
              });

              // ✅ 优先使用 task_id 查找（更可靠），降级到 order
              const subtask = data.task_id
                ? currentMsg.subtasks.find(s => s.task_id === data.task_id)
                : currentMsg.subtasks.find(s => s.order === data.subtask_order);

              if (subtask) {
                // 确保有 currentStep，如果没有则创建一个临时的
                if (!subtask.currentStep) {
                  console.warn('[V2] tool_start received without currentStep, creating temporary step');
                  const tempStep = {
                    round: data.round || subtask.react_steps.length + 1,
                    thought: '(工具调用中...)',
                    toolCalls: [],
                    expanded: true
                  };
                  subtask.react_steps.push(tempStep);
                  subtask.currentStep = tempStep;
                }

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
              } else {
                console.warn('[V2] tool_start: subtask not found for order', data.subtask_order, data);
              }
            }
            else if (data.type === 'tool_end') {
              // ✅ 优先使用 task_id 查找（更可靠），降级到 order
              const subtask = data.task_id
                ? currentMsg.subtasks.find(s => s.task_id === data.task_id)
                : currentMsg.subtasks.find(s => s.order === data.subtask_order);

              if (subtask) {
                const updateTool = (list) => {
                  const idx = list.findIndex(t => t.tool_name === data.tool_name && t.status === 'running');
                  if (idx >= 0) {
                    list[idx].status = 'success';
                    list[idx].result = data.result;
                    list[idx].elapsed_time = data.elapsed_time;
                  }
                };

                if (subtask.currentStep) {
                  updateTool(subtask.currentStep.toolCalls);
                }
                updateTool(subtask.tool_calls);
              } else {
                console.warn('[V2] tool_end: subtask not found for order', data.subtask_order, data);
              }
            }
            else if (data.type === 'tool_error') {
              // ✅ 优先使用 task_id 查找（更可靠），降级到 order
              const subtask = data.task_id
                ? currentMsg.subtasks.find(s => s.task_id === data.task_id)
                : currentMsg.subtasks.find(s => s.order === data.subtask_order);

              if (subtask) {
                const updateTool = (list) => {
                  const idx = list.findIndex(t => t.tool_name === data.tool_name && t.status === 'running');
                  if (idx >= 0) {
                    list[idx].status = 'error';
                    list[idx].result = { error: data.error };
                    list[idx].elapsed_time = 0;
                  }
                };

                if (subtask.currentStep) {
                  updateTool(subtask.currentStep.toolCalls);
                }
                updateTool(subtask.tool_calls);
              } else {
                console.warn('[V2] tool_error: subtask not found for order', data.subtask_order, data);
              }
            }
            else if (data.type === 'subtask_end') {
              // ✅ 优先使用 task_id 查找（更可靠），降级到 order
              const subtask = data.task_id
                ? currentMsg.subtasks.find(s => s.task_id === data.task_id)
                : currentMsg.subtasks.find(s => s.order === data.order);

              if (subtask) {
                subtask.result_summary = data.result_summary;
                subtask.status = data.success === false ? 'error' : 'success';
                subtask.expanded = false;
              } else {
                console.warn('[V2] subtask_end: subtask not found', {
                  task_id: data.task_id,
                  order: data.order,
                  available_subtasks: currentMsg.subtasks.map(s => ({ task_id: s.task_id, order: s.order }))
                });
              }
            }
            // final_answer 事件（ReAct 完成时发送，不需要特殊渲染）
            else if (data.type === 'final_answer') {
              // 此事件表示 ReAct 智能体已完成推理
              // 结果会通过 subtask_end 的 result_summary 展示
              // 这里只记录日志，避免重复渲染
              console.log('[V2] ReAct final_answer received:', data);
            }
            // ✨ V2 新增事件：任务跳过
            else if (data.type === 'subtask_skipped') {
              const subtask = currentMsg.subtasks.find(s => s.task_id === data.task_id);
              if (subtask) {
                subtask.status = 'skipped';
                subtask.result_summary = data.reason;
              }
            }
            // 多模态内容
            else if (data.type === 'chart_generated') {
              currentMsg.multimodalContents.push({
                type: 'chart',
                echartsConfig: data.echarts_config,
                title: data.title || 'Data Visualization',
                chartType: data.chart_type || 'bar'
              });
            }
            else if (data.type === 'map_generated') {
              currentMsg.multimodalContents.push({
                type: 'map',
                mapData: data.mapData,
                title: data.title || 'Map Visualization'
              });
            }
            else if (data.type === 'error') {
              currentMsg.status.push({ type: 'error', content: data.content });
            }
            else {
              // 捕获未处理的事件类型，帮助调试
              console.warn('[V2] Unhandled event type:', data.type, data);
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
<style scoped>


.version-badge.v2 {
  background: rgba(255, 255, 255, 0.2);
  color: white;
  padding: 4px 12px;
  border-radius: 12px;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.1em;
}

.version-label {
  flex: 1;
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.8rem;
  font-weight: 500;
}

</style>
