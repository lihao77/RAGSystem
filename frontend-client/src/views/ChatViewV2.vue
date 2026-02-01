<template>
  <div class="chat-view">
    <!-- 遮罩层（移动端） -->
    <div class="sidebar-backdrop" :class="{ 'active': mobileOpen }" @click="closeMobileSidebar"></div>

    <!-- Sidebar -->
    <aside ref="sidebarRef" class="sidebar" :class="{
      'collapsed': sidebarCollapsed,
      'mobile-open': mobileOpen
    }" @touchstart="handleTouchStart" @touchmove="handleTouchMove" @touchend="handleTouchEnd">
      <!-- 系统 Logo 和折叠按钮 -->
      <div class="sidebar-top-bar">
        <div class="sidebar-logo-wrapper" @click="toggleSidebar">
          <!-- 系统 Logo -->
          <IconLogo :size="32" class="sidebar-logo-icon" simple />

          <!-- 展开图标（仅在折叠状态 hover 时显示） -->
          <IconChevronRight :size="20" class="sidebar-expand-icon" />
        </div>

        <!-- 折叠按钮 -->
        <button class="toggle-sidebar-btn" @click="toggleSidebar" :title="'Collapse sidebar'">
          <IconChevronLeft :size="20" />
        </button>
      </div>

      <div class="sidebar-header">
        <button class="sidebar-btn" @click="startNewChat">
          <IconNewConversation :size="22" class="icon" />
          <span class="btn-text">新聊天</span>
        </button>
      </div>

      <div class="history-list">
        <div class="history-label">Recent</div>
        <div v-for="(item, index) in history" :key="index" class="history-item">
          <!-- 网页图标 -->
          <IconDocument :size="18" class="history-icon" />
          <span class="history-title">{{ item.title || 'New Conversation' }}</span>
        </div>
      </div>

      <a class="user-profile">
        <div class="avatar">U</div>
        <div class="user-info">
          <div class="username">User</div>
          <div class="user-status">Pro Plan · V2</div>
        </div>
      </a>
    </aside>

    <!-- Main Chat Area -->
    <main class="chat-main" :class="{ 'has-messages': messages.length > 0 }">
      <!-- 顶部控制栏 -->
      <div class="top-controls-bar glass-card" ref="topControlsBarRef">
        <!-- 左侧：汉堡菜单 + LLM 选择器 -->
        <div class="left-controls glass-card">
          <!-- 汉堡菜单按钮（移动端） -->
          <button class="hamburger-menu-btn" @click="openMobileSidebar" :title="'Open menu'">
            <IconMenu :size="20" />
          </button>

          <LLMSelector :model-value="selectedLLM" @update:model-value="emit('update:selectedLLM', $event)" />
        </div>

        <!-- 右侧：Version + Theme -->
        <div class="right-controls glass-card">
          <button @click="emit('toggleVersion')" class="version-btn btn" :title="useV2 ? '切换到 V1' : '切换到 V2'">
            <span class="version-label">{{ useV2 ? 'V2' : 'V1' }}</span>
          </button>

          <button @click="emit('toggleTheme')" class="theme-btn btn" :title="isDark ? '切换到亮色模式' : '切换到暗色模式'">
            <!-- Sun icon for dark mode -->
            <svg v-if="isDark" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="5"></circle>
              <line x1="12" y1="1" x2="12" y2="3"></line>
              <line x1="12" y1="21" x2="12" y2="23"></line>
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
              <line x1="1" y1="12" x2="3" y2="12"></line>
              <line x1="21" y1="12" x2="23" y2="12"></line>
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
            </svg>
            <!-- Moon icon for light mode -->
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="chat-messages-wrapper">
        <div class="chat-messages" ref="messagesRef" @scroll="handleScroll">
          <!-- Welcome Screen -->
          <div v-if="messages.length === 0" class="welcome-screen">
            <div class="welcome-content">
              <div class="welcome-header">
                <div class="logo-placeholder">
                  <!-- 系统 Logo -->
                  <IconLogo :size="80" animated />
                </div>
                <h1>RAG Agent System V2</h1>
                <p class="welcome-subtitle">Dynamic Agent Orchestration with ReAct Pattern</p>
              </div>
            </div>
          </div>


          <!-- Message Stream -->
          <div v-else class="message-stream">
            <div v-for="(msg, index) in messages" :key="index" :class="['message', msg.role]" :data-msg-index="index">
              <!-- Subtasks Container - 占满整个 message 宽度 -->
              <div v-if="msg.role === 'assistant' && msg.subtasks && msg.subtasks.length > 0"
                class="subtasks-container-full">
                <!-- 常驻 Ticker (现在同时作为 Header) -->
                <SubtaskStatusTicker :subtasks="msg.subtasks" :expanded="msg.showFullSubtasks"
                  @toggle-view="msg.showFullSubtasks = !msg.showFullSubtasks" />

                <!-- 完整详情模式 -->
                <transition name="expand">
                  <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
                    <div class="subtasks-list">
                      <!-- 轮次循环 -->
                      <div v-for="(roundGroup, roundNum) in groupSubtasksByRound(msg.subtasks)" :key="roundNum"
                        class="round-group">
                        <div v-if="Object.keys(groupSubtasksByRound(msg.subtasks)).length > 1" class="round-header">
                          Round {{ roundNum }}
                        </div>
                        <!-- 每个 subtask 卡片 -->
                        <SubtaskCard v-for="(subtask, index) in roundGroup" :key="subtask.order" :subtask="subtask"
                          @update:expanded="expandSubtask(msg.subtasks, subtask.task_id)" />
                      </div>
                    </div>

                  </div>
                </transition>

              </div>

              <div class="message-content-wrapper">
                <div class="message-content">
                  <!-- Loading State -->
                  <div v-if="msg.role === 'assistant' && !msg.content && (!msg.subtasks || msg.subtasks.length === 0)"
                    class="loading-indicator">
                    <div class="dot"></div>
                    <div class="dot"></div>
                    <div class="dot"></div>
                  </div>


                  <!-- Multimodal Content -->
                  <MultimodalContent v-if="msg.multimodalContents && msg.multimodalContents.length > 0"
                    :contents="msg.multimodalContents" />

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
          <ChatInput v-model="inputMessage" :isLoading="isLoading" @send="handleSend" />
        </div>
      </div>



    </main>
  </div>
</template>

<script setup>
import { ref, nextTick, onMounted, onUnmounted } from 'vue';
import { renderMarkdown } from '../utils/markdown';
import SubtaskCard from '../components/SubtaskCard.vue';
import SubtaskStatusTicker from '../components/SubtaskStatusTicker.vue';
import ChatInput from '../components/ChatInput.vue';
import MultimodalContent from '../components/MultimodalContent.vue';
import LLMSelector from '../components/LLMSelector.vue';
import { IconLogo, IconChevronLeft, IconChevronRight, IconDocument, IconPlus, IconNewConversation, IconMenu } from '../components/icons';
import { Icon } from 'leaflet';

// Props
const props = defineProps({
  selectedLLM: {
    type: String,
    default: ''
  },
  useV2: {
    type: Boolean,
    default: false
  },
  isDark: {
    type: Boolean,
    default: true
  }
});

// Emits
const emit = defineEmits(['update:selectedLLM', 'toggleVersion', 'toggleTheme']);

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const messagesRef = ref(null);
const topControlsBarRef = ref(null);
const sidebarRef = ref(null);
const history = ref([]);
const typewriterTimers = ref(new Map());
const isUserAtBottom = ref(true);
const sidebarCollapsed = ref(false);

// 移动端状态
const mobileOpen = ref(false);
const isMobile = ref(false);

// 触摸手势状态
const touchStartX = ref(0);
const touchStartY = ref(0);
const touchCurrentX = ref(0);
const isDragging = ref(false);

// 检测是否为移动端
const checkMobile = () => {
  isMobile.value = window.innerWidth < 768;
};

// Sidebar 切换逻辑
const toggleSidebar = () => {
  if (isMobile.value) {
    // 移动端：关闭 sidebar
    closeMobileSidebar();
  } else {
    // 桌面端：折叠/展开
    sidebarCollapsed.value = !sidebarCollapsed.value;
  }
};

// 打开移动端侧边栏
const openMobileSidebar = () => {
  mobileOpen.value = true;
  // 禁止背景滚动
  document.body.style.overflow = 'hidden';
};

// 关闭移动端侧边栏
const closeMobileSidebar = () => {
  mobileOpen.value = false;
  // 恢复背景滚动
  document.body.style.overflow = '';
};

// 触摸手势处理：touchstart
const handleTouchStart = (e) => {
  if (!mobileOpen.value) return;
  touchStartX.value = e.touches[0].clientX;
  touchStartY.value = e.touches[0].clientY;
  isDragging.value = false;
};

// 触摸手势处理：touchmove
const handleTouchMove = (e) => {
  if (!mobileOpen.value) return;
  touchCurrentX.value = e.touches[0].clientX;

  const deltaX = touchCurrentX.value - touchStartX.value;
  const deltaY = Math.abs(e.touches[0].clientY - touchStartY.value);

  // 如果横向滑动距离大于纵向，判断为滑动关闭手势
  if (Math.abs(deltaX) > 10 && Math.abs(deltaX) > deltaY) {
    isDragging.value = true;

    // 向左滑动（关闭）
    if (deltaX < 0 && sidebarRef.value) {
      const translateX = Math.max(deltaX, -280);
      sidebarRef.value.style.transform = `translateX(${translateX}px)`;
      e.preventDefault(); // 阻止页面滚动
    }
  }
};

// 触摸手势处理：touchend
const handleTouchEnd = (e) => {
  if (!mobileOpen.value || !isDragging.value) {
    if (sidebarRef.value) {
      sidebarRef.value.style.transform = '';
    }
    return;
  }

  const deltaX = touchCurrentX.value - touchStartX.value;

  // 滑动距离超过 100px 或速度足够快，则关闭
  if (deltaX < -100 || (deltaX < -30 && Math.abs(deltaX) > 50)) {
    closeMobileSidebar();
  }

  // 重置 transform
  if (sidebarRef.value) {
    sidebarRef.value.style.transform = '';
  }

  isDragging.value = false;
};

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

  // 控制 top-controls-bar 的边框显示
  if (messagesRef.value && topControlsBarRef.value) {
    if (messagesRef.value.scrollTop > 0) {
      topControlsBarRef.value.classList.add('scrolled');
    } else {
      topControlsBarRef.value.classList.remove('scrolled');
    }
  }
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

// 🎯 V1 风格：手风琴逻辑（一次只展开一个）
const expandSubtask = (subtasks, taskId) => {
  subtasks.forEach(task => {
    // 如果是当前点击的任务，则切换状态；其他的全部折叠
    if (task.task_id === taskId) {
      task.expanded = !task.expanded;
    } else {
      task.expanded = false;
    }
  });
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
    status: [],
    finished: false
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
      if (done) {
        messages.value[assistantMsgIndex].finished = true;
        break;
      }

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
              // 🎯 直接拼接 chunk，不使用打字机（让 markdown 正确渲染）
              currentMsg.content += content;
              scrollToBottom();
            }
            // 最终答案（完整 - 仅用于元数据和验证）
            else if (data.type === 'final_answer') {
              // 🎯 不覆盖内容，因为已经通过 chunk 流式接收了
              // 只用于验证和获取元数据
              if (!currentMsg.content || currentMsg.content.length === 0) {
                // 降级：如果没有收到 chunk，使用完整内容
                currentMsg.content = data.content;
              }
              // 可以在这里记录元数据
              if (data.metadata) {
                currentMsg.metadata = data.metadata;
              }
              currentMsg.finished = true;
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
    messages.value[assistantMsgIndex].finished = true;
  } finally {
    isLoading.value = false;
    scrollToBottom();
  }
};

onMounted(() => {
  isUserAtBottom.value = true;

  // 初始化移动端检测
  checkMobile();

  // 监听窗口大小变化
  window.addEventListener('resize', checkMobile);
});

onUnmounted(() => {
  // 清理事件监听器
  window.removeEventListener('resize', checkMobile);

  // 恢复 body 滚动（防止移动端打开侧边栏后离开页面）
  document.body.style.overflow = '';
});
</script>

<style scoped src="../styles/chat-view.css"></style>
