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
        <button class="sidebar-btn sidebar-btn-monitor" @click="goToMonitor" title="智能体性能监控">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
          </svg>
          <span class="btn-text">监控面板</span>
        </button>
      </div>

      <div class="history-list" ref="historyListRef" @scroll="handleHistoryScroll">
        <div class="history-label">Recent</div>
        <div v-if="historyLoading" class="history-skeleton">
          <div v-for="n in 6" :key="`history-skeleton-${n}`" class="history-item skeleton-item">
            <div class="skeleton-icon"></div>
            <div class="skeleton-line"></div>
          </div>
        </div>
        <div v-else>
          <div v-for="item in history" :key="item.session_id" class="history-item"
            :class="{ active: item.session_id === currentSessionId }" @click="selectSession(item)">
            <IconDocument :size="18" class="history-icon" />
            <div class="history-main">
              <div class="history-title-row">
                <span class="history-title">{{ item.title || formatTitle(item) || 'New Conversation' }}</span>
                <span class="history-time">{{ formatTimeLabel(item.last_message_at) }}</span>
              </div>
              <div class="history-meta">
                <span v-if="item.unread_count > 0" class="history-unread">{{ item.unread_count }}</span>
              </div>
            </div>
            <button class="history-delete-btn" @click.stop="confirmDeleteSession(item)" title="删除会话">
              <IconTrash :size="16" />
            </button>
          </div>
          <div v-if="historyLoadingMore" class="history-loading-more">加载中...</div>
          <div v-if="historyError" class="history-error">
            <span>{{ historyError }}</span>
            <button class="retry-btn" @click="retryLoadHistory">重试</button>
          </div>
        </div>
      </div>

      <a class="user-profile">
        <div class="avatar">U</div>
        <div class="user-info">
          <div class="username">User</div>
          <div class="user-status">Pro Plan</div>
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

        <!-- 右侧：主题切换 -->
        <div class="right-controls glass-card">
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
          <div v-if="messagesLoading" class="messages-skeleton">
            <div v-for="n in 6" :key="`msg-skeleton-${n}`" class="message-skeleton-row"></div>
          </div>
          <div v-else-if="messages.length === 0" class="welcome-screen">
            <div class="welcome-content">
              <div class="welcome-header">
                <div class="logo-placeholder">
                  <!-- 系统 Logo -->
                  <IconLogo :size="80" animated />
                </div>
                <h1>RAG Agent System</h1>
                <p class="welcome-subtitle">Dynamic Agent Orchestration with ReAct Pattern</p>
              </div>
            </div>
          </div>


          <!-- Message Stream -->
          <div v-else class="message-stream">
            <div v-for="(msg, index) in visibleMessages" :key="messageKey(msg, index)" :class="['message', msg.role]" :data-msg-index="index"
              @mouseenter="messageActionsVisible = index" @mouseleave="messageActionsVisible = null">
              <!-- 持久化压缩：历史摘要占位，详情默认折叠 -->
              <div v-if="msg.role === 'system' && msg.metadata && msg.metadata.compression" class="message-content-wrapper compression-summary">
                <div class="compression-summary-label" @click="expandedSummarySeq = (expandedSummarySeq === msg.seq ? null : msg.seq)">
                  <span class="compression-summary-title">历史摘要</span>
                  <span class="compression-summary-toggle">{{ expandedSummarySeq === msg.seq ? '收起' : '展开' }}</span>
                </div>
                <div v-show="expandedSummarySeq === msg.seq" class="compression-summary-detail markdown-body" v-html="renderMarkdown(msg.content || '')"></div>
              </div>
              <!-- Subtasks Container - 占满整个 message 宽度 -->
              <div v-else-if="msg.role === 'assistant' && msg.subtasks && msg.subtasks.length > 0"
                class="subtasks-container-full">
                <!-- 常驻 Ticker (现在同时作为 Header) -->
                <SubtaskStatusTicker :subtasks="msg.subtasks" :expanded="msg.showFullSubtasks"
                  @toggle-view="msg.showFullSubtasks = !msg.showFullSubtasks" />

                <!-- 视图切换按钮 -->
                <!-- 完整详情模式 -->
                <transition name="expand">
                  <div v-if="msg.showFullSubtasks" class="subtasks-full-view">
                    <!-- 层次化视图 -->
                    <HierarchicalExecutionTree
                      :master-steps="msg.master_steps || []"
                      :subtasks="msg.subtasks || []"
                    />
                  </div>
                </transition>

              </div>

              <div v-if="!(msg.role === 'system' && msg.metadata && msg.metadata.compression)" class="message-content-wrapper">
                <div class="message-content">
                  <!-- Loading State -->
                  <div
                    v-if="msg.role === 'assistant' && !msg.content && (!msg.subtasks || msg.subtasks.length === 0) && !msg.finished"
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

                  <!-- User Message (可编辑时显示 textarea) -->
                  <div v-if="msg.role === 'user' && editingMessage !== msg" class="user-text">
                    {{ msg.content }}
                  </div>
                  <div v-else-if="msg.role === 'user' && editingMessage === msg" class="user-edit-row">
                    <textarea v-model="editingDraft" class="user-edit-input" rows="3" @keydown.ctrl.enter="confirmEditAndResend" @keydown.meta.enter="confirmEditAndResend" />
                    <div class="user-edit-actions">
                      <button type="button" class="btn-editor btn-save" @click="confirmEditAndResend">确定</button>
                      <button type="button" class="btn-editor btn-cancel" @click="cancelEdit">取消</button>
                    </div>
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
              <!-- 消息操作：仅 user 可编辑、复制、从此处重试 -->
              <div class="message-actions" :class="{ 'visible': messageActionsVisible === index }">
                <template v-if="msg.role === 'user'">
                  <button v-if="msg.seq != null" type="button" class="msg-action-btn" title="删除此条之后的对话并用原问题重新执行（流式输出）" @click="rollbackAndRetry(msg)">
                    从此处重试
                  </button>
                  <button type="button" class="msg-action-btn" title="编辑后确定将替换该条并重新生成回复" @click="startEditMessage(msg)">
                    编辑
                  </button>
                  <button type="button" class="msg-action-btn" title="复制内容" @click="copyMessage(msg)">
                    复制
                  </button>
                </template>
              </div>
            </div>
          </div>
        </div>
        <!-- <div class="input-area-wrapper" :class="{ 'centered': messages.length === 0 }"> -->
        <div class="input-area-wrapper">
          <div v-if="contextUsage && contextUsage.max > 0" class="context-usage-bar">
            <svg width="22" height="22" viewBox="0 0 22 22" class="ctx-ring-master" :title="`上下文: ${contextUsage.used.toLocaleString()} / ${contextUsage.max.toLocaleString()} tokens`">
              <circle cx="11" cy="11" r="9" fill="none" stroke="#dcdfe6" stroke-width="2.5" />
              <circle
                cx="11"
                cy="11"
                r="9"
                fill="none"
                :stroke="contextUsageClass === 'danger' ? '#ff4d4f' : contextUsageClass === 'warning' ? '#faad14' : '#52c41a'"
                stroke-width="2.5"
                stroke-linecap="round"
                :stroke-dasharray="`${contextUsagePct * 0.5655} 56.55`"
                stroke-dashoffset="0"
                :style="{ transform: 'rotate(90deg) scaleX(-1)', transformOrigin: '50% 50%' }"
              />
            </svg>
            <span class="context-usage-label">{{ contextUsage.used.toLocaleString() }} / {{ contextUsage.max.toLocaleString() }} tokens</span>
          </div>
          <ChatInput ref="chatInputRef" v-model="inputMessage" :isLoading="isLoading" @send="handleSend" />
        </div>
      </div>



    </main>
    <div v-if="toast.visible" class="toast" :class="toast.type">
      <span>{{ toast.message }}</span>
      <button v-if="toast.action" class="toast-action" @click="toast.action">{{ toast.actionLabel }}</button>
    </div>

    <!-- 确认对话框 -->
    <ConfirmDialog
      ref="confirmDialogRef"
      :title="confirmDialog.title"
      :message="confirmDialog.message"
      :confirm-text="confirmDialog.confirmText"
      :cancel-text="confirmDialog.cancelText"
      @confirm="confirmDialog.onConfirm"
      @cancel="confirmDialog.onCancel"
    />
  </div>
</template>

<script setup>
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { renderMarkdown } from '../utils/markdown';
import SubtaskStatusTicker from '../components/SubtaskStatusTicker.vue';
import HierarchicalExecutionTree from '../components/HierarchicalExecutionTree.vue';
import ChatInput from '../components/ChatInput.vue';
import MultimodalContent from '../components/MultimodalContent.vue';
import LLMSelector from '../components/LLMSelector.vue';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import { IconLogo, IconChevronLeft, IconChevronRight, IconDocument, IconPlus, IconNewConversation, IconMenu, IconTrash } from '../components/icons';
import { Icon } from 'leaflet';

// Props
const props = defineProps({
  selectedLLM: {
    type: String,
    default: ''
  },
  isDark: {
    type: Boolean,
    default: true
  }
});

// Emits
const emit = defineEmits(['update:selectedLLM', 'toggleTheme', 'navigate']);

const messages = ref([]);
const inputMessage = ref('');
const isLoading = ref(false);
const messagesRef = ref(null);
const topControlsBarRef = ref(null);
const sidebarRef = ref(null);
const historyListRef = ref(null);
const history = ref([]);
const typewriterTimers = ref(new Map());
const isUserAtBottom = ref(true);
const sidebarCollapsed = ref(false);
const historyLoading = ref(false);
const historyLoadingMore = ref(false);
const historyError = ref('');
const historyOffset = ref(0);
const historyHasMore = ref(true);
const currentSessionId = ref(null);
const messagesLoading = ref(false);
const chatInputRef = ref(null);
const confirmDialogRef = ref(null);
const toast = ref({
  visible: false,
  message: '',
  type: 'error',
  action: null,
  actionLabel: ''
});
const confirmDialog = ref({
  title: '确认操作',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  onConfirm: () => {},
  onCancel: () => {}
});
const currentStreamController = ref(null);
const contextUsage = ref({ used: 0, max: 0 });
const messageCache = ref(new Map());
const maxCachedSessions = 10;
const lastFailedSendContent = ref('');
const messageActionsVisible = ref(null);
const editingMessageIndex = ref(null);
const editingDraft = ref('');
/** 展开查看详情的摘要消息 seq（持久化压缩：仅一条生效，用 seq 区分） */
const expandedSummarySeq = ref(null);
const handlePopState = () => {
  const match = window.location.pathname.match(/^\/chat\/([^/]+)$/);
  const sessionId = match ? decodeURIComponent(match[1]) : null;
  if (sessionId && sessionId !== currentSessionId.value) {
    currentSessionId.value = sessionId;
    loadSessionMessages(sessionId);
  }
  if (!sessionId) {
    currentSessionId.value = null;
    messages.value = [];
  }
};

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
  currentSessionId.value = null;
  window.history.pushState({}, '', '/');
  focusInput();
};

const goToMonitor = () => {
  emit('navigate', '/monitor');
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

// 🎯 统一的 Agent 信息解析：从事件 / 持久化 payload 中取「被调用 Agent」与展示名
const getCalledAgentAndDisplayName = (eventOrStep) => {
  // eventOrStep 可能是 SSE 里的 event，也可能是持久化的 step
  const payload = eventOrStep && eventOrStep.payload ? eventOrStep.payload : null;
  const eventData = payload ? (payload.data || {}) : (eventOrStep.data || {});
  const publisherAgent = payload ? payload.agent_name : eventOrStep.agent_name;

  // 被调用的 Agent：优先用 data.agent_name，其次退回事件的 agent_name
  const calledAgent = eventData.agent_name != null ? eventData.agent_name : publisherAgent;

  // 展示名：优先用 agent_display_name / subtask_agent，其次退回被调用 Agent 名
  const displayName =
    eventData.agent_display_name ||
    eventData.subtask_agent ||
    calledAgent;

  return { calledAgent, displayName };
};

// 🎯 将持久化的 steps 还原为 subtasks 与 master_steps（基于 call_id 和 parent_call_id 构建调用树）
function stepsToSubtasks(steps) {
  if (!Array.isArray(steps) || steps.length === 0) return { subtasks: [], master_steps: [] };

  const callNodes = new Map();
  const toolCalls = new Map();
  const master_steps = [];

  const getData = (s) => (s && s.payload && s.payload.data) ? s.payload.data : {};
  const getAgentName = (s) => (s && s.payload && s.payload.agent_name) ? s.payload.agent_name : null;

  // 第一遍：收集所有节点
  for (const step of steps) {
    const eventType = step.step_type || (step.payload && step.payload.type);
    const eventData = getData(step);
    const agentName = getAgentName(step);
    const callId = step.payload?.call_id;
    const parentCallId = step.payload?.parent_call_id;

    // Agent 调用开始
    if (eventType === 'call.agent.start' || eventType === 'subtask.start') {
      const { calledAgent, displayName } = getCalledAgentAndDisplayName(step);

      // 跳过 MasterAgent（它不显示在 subtasks 中）
      if (calledAgent === 'master_agent_v2') continue;

      callNodes.set(callId, {
        call_id: callId,
        parent_call_id: parentCallId,
        order: eventData.order,
        task_id: callId,
        round: eventData.round,
        round_index: eventData.round_index,
        agent_name: calledAgent,
        agent_display_name: displayName,
        description: eventData.description || eventData.subtask_description,
        react_steps: [],
        tool_calls: [],
        result_summary: '',
        status: 'running',
        expanded: true,
        currentStep: null
      });
    }

    // Agent 调用结束
    else if (eventType === 'call.agent.end' || eventType === 'subtask.end') {
      const node = callNodes.get(callId);
      if (node) {
        node.status = eventData.success === false ? 'error' : 'success';
        node.result_summary = eventData.result_summary || eventData.result || '';
        node.expanded = false;
      }
    }

    // 思考过程
    else if (eventType === 'agent.thought_structured') {
      const agentCallId = step.payload?.call_id;
      const isMasterThought = (step.payload?.agent_name || eventData.agent_name) === 'master_agent_v2';
      if (isMasterThought) {
        master_steps.push({ round: eventData.round, thought: eventData.thought || '', toolCalls: [], expanded: true });
        continue;
      }
      const node = callNodes.get(agentCallId);
      if (node) {
        const newStep = {
          round: eventData.round,
          thought: eventData.thought || '',
          toolCalls: [],
          expanded: true
        };
        node.react_steps.push(newStep);
        node.currentStep = newStep;
      }
    }

    // 工具调用开始
    else if (eventType === 'call.tool.start' || eventType === 'tool.start') {
      const parentNode = callNodes.get(parentCallId);
      const toolCall = {
        call_id: callId,
        parent_call_id: parentCallId,
        tool_name: eventData.tool_name,
        arguments: eventData.arguments,
        status: 'running',
        showResult: false,
        showArgs: false
      };
      toolCalls.set(callId, toolCall);
      if (parentNode) {
        parentNode.tool_calls.push(toolCall);
        if (parentNode.currentStep) {
          parentNode.currentStep.toolCalls.push(toolCall);
        } else if (parentNode.react_steps.length > 0) {
          parentNode.react_steps[parentNode.react_steps.length - 1].toolCalls.push(toolCall);
        }
      }
    }

    // 工具调用结束
    else if (eventType === 'call.tool.end' || eventType === 'tool.end') {
      const toolCall = toolCalls.get(callId);
      if (toolCall) {
        toolCall.status = 'success';
        toolCall.result = eventData.result;
        toolCall.elapsed_time = eventData.elapsed_time || eventData.execution_time;
      }
    }
  }

  const subtasks = Array.from(callNodes.values());
  return { subtasks, master_steps };
}

const isMasterEvent = (event) => {
  const agentName = event.agent_name || event.data?.agent_name;
  return !agentName || agentName === 'master_agent_v2';
};

const findSubtaskByCallId = (subtasks, callId) => {
  if (!callId || !Array.isArray(subtasks)) return null;
  return subtasks.find(s => s.task_id === callId) || null;
};

const formatTitle = (item) => {
  const content = (item.first_message || item.last_message || '').trim();
  return content ? content.slice(0, 30) : '';
};

const formatTimeLabel = (timeStr) => {
  if (!timeStr) return '';
  const time = new Date(timeStr);
  if (Number.isNaN(time.getTime())) return '';
  const now = new Date();
  const diffMs = now - time;
  const diffMinutes = Math.floor(diffMs / 60000);
  if (diffMinutes < 1) return '刚刚';
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  const isYesterday = now.toDateString() !== time.toDateString()
    && new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1).toDateString() === time.toDateString();
  if (isYesterday) return '昨天';
  const yyyy = time.getFullYear();
  const mm = String(time.getMonth() + 1).padStart(2, '0');
  const dd = String(time.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

const showToast = (message, actionOrType = null, actionLabel = '重试') => {
  let type = 'error';
  let action = null;
  if (typeof actionOrType === 'string' && (actionOrType === 'success' || actionOrType === 'error')) {
    type = actionOrType;
  } else if (typeof actionOrType === 'function') {
    action = actionOrType;
  }
  toast.value = {
    visible: true,
    message,
    type,
    action,
    actionLabel
  };
  setTimeout(() => {
    if (toast.value.visible && toast.value.message === message) {
      toast.value.visible = false;
    }
  }, 3000);
};

const focusInput = async () => {
  if (chatInputRef.value?.focus) {
    await chatInputRef.value.focus();
  }
};

const handleHistoryScroll = () => {
  if (!historyListRef.value || historyLoadingMore.value || !historyHasMore.value) return;
  const el = historyListRef.value;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    loadRecentSessions(false);
  }
};

const loadRecentSessions = async (reset = false) => {
  if (historyLoading.value || historyLoadingMore.value) return;
  if (!historyHasMore.value && !reset) return;
  if (reset) {
    historyOffset.value = 0;
    historyHasMore.value = true;
  }
  if (reset) {
    historyLoading.value = true;
  } else {
    historyLoadingMore.value = true;
  }
  historyError.value = '';
  try {
    const userId = (localStorage.getItem('userId') || '').trim();
    const params = new URLSearchParams({
      limit: String(20),
      offset: String(historyOffset.value)
    });
    if (userId) {
      params.set('user_id', userId);
    }
    const response = await fetch(`/api/agent/sessions?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    const payload = result.data || {};
    const items = payload.items || [];
    if (reset) {
      history.value = items;
    } else {
      history.value = history.value.concat(items);
    }
    historyOffset.value += items.length;
    historyHasMore.value = payload.has_more ?? items.length >= 20;
  } catch (error) {
    historyError.value = '加载失败，请重试';
    showToast('加载历史列表失败', retryLoadHistory);
  } finally {
    historyLoading.value = false;
    historyLoadingMore.value = false;
  }
};

const retryLoadHistory = () => {
  loadRecentSessions(true);
};

const cacheMessages = (sessionId, list) => {
  if (!sessionId) return;
  if (messageCache.value.has(sessionId)) {
    messageCache.value.delete(sessionId);
  }
  messageCache.value.set(sessionId, list.slice(-500));
  if (messageCache.value.size > maxCachedSessions) {
    const oldestKey = messageCache.value.keys().next().value;
    messageCache.value.delete(oldestKey);
  }
};

/** 仅从服务端拉取并合并 id/seq 到当前列表（不替换整表，避免闪烁） */
const mergeMessageIdsFromServer = async (sessionId) => {
  if (!sessionId || messages.value.length === 0) return;
  try {
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&offset=0`);
    if (!res.ok) return;
    const result = await res.json();
    const items = result.data?.items || [];
    if (items.length !== messages.value.length) return;
    for (let i = 0; i < items.length; i++) {
      const m = messages.value[i];
      const it = items[i];
      if (!m || !it) continue;
      if (m.role !== it.role) continue;
      m.id = it.id;
      m.seq = it.seq;
      if (it.role === 'assistant' && (it.steps || it.metadata?.steps)?.length && !m.subtasks?.length) {
        const parsed = stepsToSubtasks(it.steps || it.metadata.steps);
        m.subtasks = parsed.subtasks;
        if (parsed.master_steps?.length) m.master_steps = parsed.master_steps;
      }
    }
    cacheMessages(sessionId, messages.value);
  } catch (_) {}
};

const loadSessionMessages = async (sessionId) => {
  if (!sessionId) return;
  if (currentStreamController.value) {
    currentStreamController.value.abort();
    currentStreamController.value = null;
  }
  messagesLoading.value = true;
  historyError.value = '';
  try {
    const cached = messageCache.value.get(sessionId);
    if (cached) {
      messages.value = cached;
      await nextTick();
      await scrollToBottom(true);
      focusInput();
      messagesLoading.value = false;
      return;
    }
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/messages?limit=500&offset=0`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    const items = result.data?.items || [];
    const mapped = items.map(item => {
      if (item.role === 'assistant') {
        const steps = item.steps || item.metadata?.steps;
        const parsed = Array.isArray(steps) ? stepsToSubtasks(steps) : { subtasks: [], master_steps: [] };
        const subtasks = parsed.subtasks || [];
        return {
          role: 'assistant',
          id: item.id,
          seq: item.seq,
          content: item.content || '',
          subtasks,
          master_steps: parsed.master_steps || [],
          showFullSubtasks: false,
          multimodalContents: item.multimodalContents || [],
          status: item.status || [],
          finished: true
        };
      }
      if (item.role === 'system') {
        return {
          role: 'system',
          id: item.id,
          seq: item.seq,
          content: item.content || '',
          metadata: item.metadata || {}
        };
      }
      return { role: 'user', id: item.id, seq: item.seq, content: item.content || '', metadata: item.metadata || {} };
    });
    messages.value = mapped;
    expandedSummarySeq.value = null;
    cacheMessages(sessionId, mapped);
    await nextTick();
    await scrollToBottom(true);
    focusInput();
  } catch (error) {
    showToast('加载会话失败', () => loadSessionMessages(sessionId));
  } finally {
    messagesLoading.value = false;
  }
};

const selectSession = async (item) => {
  if (!item?.session_id) return;
  if (currentSessionId.value === item.session_id && messages.value.length > 0) return;
  currentSessionId.value = item.session_id;
  window.history.pushState({}, '', `/chat/${encodeURIComponent(item.session_id)}`);
  item.unread_count = 0;
  closeMobileSidebar();
  await loadSessionMessages(item.session_id);
};

const updateRecentSession = (sessionId, content, timestamp) => {
  if (!sessionId) return;
  const time = timestamp || new Date().toISOString();
  const idx = history.value.findIndex(h => h.session_id === sessionId);
  if (idx >= 0) {
    const item = history.value[idx];
    item.last_message = content;
    item.last_message_at = time;
    if (!item.title) {
      item.title = (item.title || content || '').toString().slice(0, 30);
    }
    history.value.splice(idx, 1);
    history.value.unshift(item);
  } else {
    history.value.unshift({
      session_id: sessionId,
      title: content ? content.slice(0, 30) : '',
      last_message: content,
      last_message_at: time,
      unread_count: 0
    });
  }
};

const messageKey = (msg, index) => msg.id != null ? `msg-${msg.id}` : `idx-${index}`;

/** 用于展示的消息列表：按 seq 升序，若有 compression 则隐藏 seq < 最后一条摘要.seq 的消息 */
const visibleMessages = computed(() => {
  const list = messages.value;
  if (!list.length) return [];
  const withSeq = list.filter(m => m.seq != null);
  const summaryMsg = withSeq.filter(m => (m.metadata && m.metadata.compression) === true).sort((a, b) => (b.seq - a.seq))[0];
  const summarySeq = summaryMsg ? summaryMsg.seq : null;
  if (summarySeq == null) return list;
  return list.filter(m => m.seq == null || m.seq >= summarySeq);
});

const editingMessage = computed(() => {
  const i = editingMessageIndex.value;
  if (i == null || i < 0) return null;
  return messages.value[i] || null;
});

const contextUsagePct = computed(() => {
  if (!contextUsage.value?.max) return 0;
  return Math.min(100, Math.round(contextUsage.value.used / contextUsage.value.max * 100));
});

const contextUsageClass = computed(() => {
  const pct = contextUsagePct.value;
  if (pct >= 90) return 'danger';
  if (pct >= 70) return 'warning';
  return '';
});

const copyToClipboard = async (text) => {
  if (!text) return false;
  // 优先使用 Clipboard API（仅在安全上下文可用）
  try {
    if (typeof navigator !== 'undefined' &&
        navigator.clipboard &&
        typeof navigator.clipboard.writeText === 'function' &&
        typeof window !== 'undefined' &&
        window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (e) {
    // 忽略错误，继续走后备方案
  }

  // 回退到隐藏 textarea + execCommand（兼容部分手机浏览器）
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.top = '-9999px';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand && document.execCommand('copy');
    document.body.removeChild(textarea);
    return !!ok;
  } catch (e) {
    return false;
  }
};

const startEditMessage = (msg, index) => {
  const idx = messages.value.findIndex(m => m === msg);
  editingMessageIndex.value = idx >= 0 ? idx : index;
  editingDraft.value = msg.content || '';
};

const cancelEdit = () => {
  editingMessageIndex.value = null;
  editingDraft.value = '';
};

/** 编辑后确定：先回退到该条之前，再以编辑后的内容流式发送（保持原有流式体验） */
const confirmEditAndResend = async () => {
  const idx = editingMessageIndex.value;
  if (idx == null) return;
  const msg = messages.value[idx];
  if (!msg || msg.role !== 'user') {
    cancelEdit();
    return;
  }
  const content = (editingDraft.value || '').trim();
  if (!content) {
    showToast('内容不能为空');
    return;
  }
  const sessionId = currentSessionId.value;
  if (!sessionId) { cancelEdit(); return; }
  const prevMessages = messages.value.slice();
  messages.value = messages.value.slice(0, idx);
  cacheMessages(sessionId, messages.value);
  try {
    let body;
    if (idx === 0) {
      body = { after_seq: -1 };
    } else {
      const prev = messages.value[idx - 1];
      body = prev.id ? { after_message_id: prev.id } : (prev.seq != null ? { after_seq: prev.seq } : { after_seq: -1 });
    }
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || '回退失败');
    }
    inputMessage.value = content;
    cancelEdit();
    await nextTick();
    handleSend();
  } catch (e) {
    messages.value = prevMessages;
    cacheMessages(sessionId, prevMessages);
    cancelEdit();
    showToast(e.message || '操作失败');
  }
};

/** 从此处重试：仅回退到该条之后，再用原问题流式发送（与正常发送一致，有流式输出） */
const rollbackAndRetry = async (msg) => {
  const sessionId = currentSessionId.value;
  if (!sessionId) {
    showToast('当前无会话');
    return;
  }
  if (msg.role !== 'user' || msg.seq == null) {
    showToast('仅支持从用户消息重试，且需已加载序号');
    return;
  }
  const idx = messages.value.findIndex(m => m === msg || (m.role === 'user' && m.seq === msg.seq));
  if (idx < 0) return;
  const prevMessages = messages.value.slice();
  try {
    const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}/rollback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ after_seq: msg.seq })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.message || '回退失败');
    }
    messages.value = messages.value.slice(0, idx + 1);
    cacheMessages(sessionId, messages.value);
    inputMessage.value = (msg.content || '').trim();
    await nextTick();
    handleSend();
  } catch (e) {
    messages.value = prevMessages;
    cacheMessages(sessionId, prevMessages);
    showToast(e.message || '回退失败');
  }
};

const copyMessage = async (msg) => {
  const text = (msg.content || '').trim();
  if (!text) {
    showToast('无内容可复制');
    return;
  }
  const ok = await copyToClipboard(text);
  if (ok) {
    showToast('已复制到剪贴板', 'success');
  } else {
    showToast('复制失败');
  }
};

const confirmDeleteSession = async (item) => {
  confirmDialog.value = {
    title: '删除会话',
    message: `确定要删除会话"${item.title || formatTitle(item) || 'New Conversation'}"吗？此操作不可恢复。`,
    confirmText: '删除',
    cancelText: '取消',
    onConfirm: () => {
      deleteSession(item.session_id);
    },
    onCancel: () => {}
  };
  confirmDialogRef.value?.show();
};

const deleteSession = async (sessionId) => {
  try {
    const response = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.message || '删除失败');
    }

    // 从历史列表中移除
    const index = history.value.findIndex(h => h.session_id === sessionId);
    if (index >= 0) {
      history.value.splice(index, 1);
    }

    // 如果删除的是当前会话，清空消息并跳转到首页
    if (currentSessionId.value === sessionId) {
      startNewChat();
    }

    // 从缓存中移除
    if (messageCache.value.has(sessionId)) {
      messageCache.value.delete(sessionId);
    }

    showToast('会话已删除', 'success');
  } catch (error) {
    showToast(error.message || '删除会话失败');
  }
};

const ensureSession = async () => {
  if (currentSessionId.value) return currentSessionId.value;
  const userId = (localStorage.getItem('userId') || '').trim();
  const body = userId ? { user_id: userId } : {};
  const response = await fetch('/api/agent/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
  const result = await response.json();
  currentSessionId.value = result.data?.session_id || null;
  if (currentSessionId.value) {
    window.history.pushState({}, '', `/chat/${encodeURIComponent(currentSessionId.value)}`);
  }
  return currentSessionId.value;
};

const handleSend = async () => {
  const content = inputMessage.value.trim();
  if (!content || isLoading.value) return;

  const sessionId = await ensureSession();
  lastFailedSendContent.value = content;
  messages.value.push({ role: 'user', content: content });
  inputMessage.value = '';
  isUserAtBottom.value = true;
  scrollToBottom(true);
  updateRecentSession(sessionId, content, new Date().toISOString());

  const assistantMsgIndex = messages.value.push({
    role: 'assistant',
    content: '',
    subtasks: [],
    master_steps: [],
    showFullSubtasks: false,
    multimodalContents: [],
    status: [],
    toolCallRegistry: new Map(),
    finished: false
  }) - 1;

  isLoading.value = true;
  contextUsage.value = { used: 0, max: 0 };

  try {
    const controller = new AbortController();
    currentStreamController.value = controller;
    const body = {
      task: content,
      session_id: sessionId,
      use_v2: true
    };
    // 前端 llm-select-trigger 选择：临时指定默认主智能体及未配置 LLM 的智能体使用的模型（格式 provider|provider_type|model_name）
    const selectedLlm = props.selectedLLM || localStorage.getItem('selectedLLMModel') || '';
    if (selectedLlm) {
      body.selected_llm = selectedLlm;
    }
    const response = await fetch('/api/agent/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify(body)
    });

    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sseBuffer = '';  // 缓冲跨 chunk 的不完整 SSE 事件

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const currentMsg = messages.value[assistantMsgIndex];
        currentMsg.finished = true;
        if (currentMsg.toolCallRegistry) currentMsg.toolCallRegistry.clear();
        const assistantContent = currentMsg.content;
        if (assistantContent) {
          updateRecentSession(sessionId, assistantContent, new Date().toISOString());
        }
        cacheMessages(sessionId, messages.value);
        mergeMessageIdsFromServer(sessionId);
        break;
      }

      sseBuffer += decoder.decode(value, { stream: true });
      const parts = sseBuffer.split('\n\n');
      // 最后一段可能不完整，保留到下次
      sseBuffer = parts.pop() || '';

      for (const line of parts) {
        if (line.startsWith('data: ')) {
          try {
            const event = JSON.parse(line.substring(6));
            const currentMsg = messages.value[assistantMsgIndex];

            // ✨ 提取事件数据（完整Event对象格式）
            const eventData = event.data || {};
            const eventType = event.type;

            // 🎯 使用与持久化相同的解析逻辑，统一「被调用 Agent」与展示名
            const { calledAgent: calledAgentForStart, displayName: displayNameForStart } = getCalledAgentAndDisplayName(event);
            if ((eventType === 'subtask.start' || eventType === 'call.agent.start') && calledAgentForStart !== 'master_agent_v2') {
              // 折叠之前的 Agent 调用
              if (currentMsg.subtasks.length > 0) {
                currentMsg.subtasks.forEach(st => st.expanded = false);
              }

              currentMsg.subtasks.push({
                order: eventData.order,
                task_id: event.call_id,
                parent_call_id: event.parent_call_id,
                round: eventData.round,
                round_index: eventData.round_index,
                agent_name: calledAgentForStart,
                agent_display_name: displayNameForStart,
                description: eventData.subtask_description || eventData.description,
                react_steps: [],
                tool_calls: [],
                result_summary: '',
                status: 'running',
                expanded: true,
                currentStep: null
              });
            }
            // 🎯 Master V2 的 thought：区分 Master 与子 Agent
            else if (eventType === 'agent.thought_structured') {
              if (isMasterEvent(event)) {
                if (!currentMsg.master_steps) currentMsg.master_steps = [];
                currentMsg.master_steps.push({
                  round: eventData.round,
                  thought: eventData.thought || '',
                  toolCalls: [],
                  expanded: true
                });
              } else {
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask) {
                  const newStep = {
                    round: eventData.round,
                    thought: eventData.thought || '',
                    toolCalls: [],
                    expanded: true
                  };
                  subtask.react_steps.push(newStep);
                  subtask.currentStep = newStep;
                }
              }
            }
            // 工具调用（支持 call.tool.start / tool.start）
            else if (eventType === 'tool.start' || eventType === 'call.tool.start') {
              const subtask = findSubtaskByCallId(currentMsg.subtasks, event.parent_call_id);
              if (subtask) {
                if (!subtask.currentStep) {
                  const newStep = {
                    round: eventData.round,
                    thought: '',
                    toolCalls: [],
                    expanded: true
                  };
                  subtask.react_steps.push(newStep);
                  subtask.currentStep = newStep;
                }
                const toolCall = {
                  tool_name: eventData.tool_name,
                  arguments: eventData.arguments,
                  status: 'running',
                  index: eventData.index,
                  total: eventData.total,
                  showResult: false,
                  showArgs: false
                };
                subtask.currentStep.toolCalls.push(toolCall);
                subtask.tool_calls.push(toolCall);
                // 注册到 registry，供 tool.end 精确匹配
                if (event.call_id && currentMsg.toolCallRegistry) {
                  currentMsg.toolCallRegistry.set(event.call_id, { toolCall, subtask });
                }
              }
            }
            else if (eventType === 'tool.end' || eventType === 'call.tool.end') {
              // 优先通过 registry 精确匹配
              const registered = event.call_id && currentMsg.toolCallRegistry?.get(event.call_id);
              if (registered) {
                registered.toolCall.status = 'success';
                registered.toolCall.result = eventData.result;
                registered.toolCall.elapsed_time = eventData.elapsed_time || eventData.execution_time;
                currentMsg.toolCallRegistry.delete(event.call_id);
              } else {
                // fallback: 通过 parent_call_id 找 subtask
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.parent_call_id);
                if (subtask) {
                  const tc = subtask.tool_calls.find(t => t.tool_name === eventData.tool_name && t.status === 'running');
                  if (tc) {
                    tc.status = 'success';
                    tc.result = eventData.result;
                    tc.elapsed_time = eventData.elapsed_time || eventData.execution_time;
                  }
                }
              }
            }
            // 🎯 三种「结束」事件职责区分：
            // - call.agent.end：子 Agent/子任务结束，只更新对应 subtask 的 result_summary、status
            // - output.final_answer：最终答案内容 + 标记本条消息完成（finished）
            // - agent.end：主 Agent 整体结束，仅作兜底（若尚未 finished 则标记完成），不重复处理内容

            // 子任务/子 Agent 调用结束：只更新对应卡片（用 data.agent_name 判断，Master 自身的 end 跳过）
            else if (eventType === 'subtask.end' || eventType === 'call.agent.end') {
              // call.agent.end 由 MasterAgent publisher 发布，event.agent_name 是 master
              // 需要用 eventData.agent_name 判断被调用的子 agent
              const calledAgent = eventData.agent_name;
              if (calledAgent && calledAgent !== 'master_agent_v2') {
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask) {
                  subtask.result_summary = eventData.subtask_result || eventData.result_summary || eventData.result;
                  subtask.status = eventData.success === false ? 'error' : 'success';
                  subtask.expanded = false;
                }
              }
            }
            // 最终答案（完整）：内容 + 元数据 + 标记消息完成
            // （流式内容已由 output.chunk 拼接，此处仅兜底与标记）
            else if (eventType === 'output.chunk') {
              if (isMasterEvent(event)) {
                currentMsg.content += eventData.content;
                scrollToBottom();
              } else {
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask) subtask.result_summary = (subtask.result_summary || '') + eventData.content;
              }
            }
            // 最终答案：Master→content+finished，子Agent→subtask.result_summary
            else if (eventType === 'output.final_answer') {
              if (isMasterEvent(event)) {
                // final_answer 是权威内容，覆盖可能不完整的 chunk 拼接
                if (eventData.content) {
                  currentMsg.content = eventData.content;
                }
                if (eventData.metadata) {
                  currentMsg.metadata = eventData.metadata;
                }
                currentMsg.finished = true;
                updateRecentSession(sessionId, currentMsg.content, new Date().toISOString());
              } else {
                // 子 agent 的 final_answer：兜底写入 subtask（不 break）
                const subtask = findSubtaskByCallId(currentMsg.subtasks, event.call_id);
                if (subtask && !subtask.result_summary) subtask.result_summary = eventData.content || '';
              }
            }
            // 主 Agent 结束：仅兜底标记完成（若未在 output.final_answer 中标记）
            else if (eventType === 'agent.end') {
              if (!currentMsg.finished) {
                currentMsg.finished = true;
                if (currentMsg.content) {
                  updateRecentSession(sessionId, currentMsg.content, new Date().toISOString());
                }
              }
            }
            // 图表生成
            else if (eventType === 'visualization.chart') {
              currentMsg.multimodalContents.push({
                type: 'chart',
                echartsConfig: eventData.echarts_config || eventData.config,
                title: eventData.title || 'Data Visualization',
                chartType: eventData.chart_type || 'bar'
              });
            }
            // 地图生成
            else if (eventType === 'visualization.map') {
              currentMsg.multimodalContents.push({
                type: 'map',
                mapData: eventData.mapData || eventData.data,
                title: eventData.title || 'Map Visualization'
              });
            }
            // 错误
            else if (eventType === 'agent.error') {
              currentMsg.status.push({ type: 'error', content: eventData.error || eventData.content });
            }
            // 上下文用量
            else if (eventType === 'context.usage') {
              const agentName = event.agent_name;
              const ctx = { used: eventData.used_tokens, max: eventData.max_tokens };
              if (!agentName || agentName === 'master_agent_v2') {
                contextUsage.value = ctx;
              } else {
                // 写入对应 subtask
                const subtask = currentMsg.subtasks.find(s => s.agent_name === agentName && s.status === 'running');
                if (subtask) subtask.ctx = ctx;
              }
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
    showToast('消息发送失败', async () => {
      if (lastFailedSendContent.value) {
        inputMessage.value = lastFailedSendContent.value;
        await nextTick();
        handleSend();
      }
    });
  } finally {
    isLoading.value = false;
    scrollToBottom();
    currentStreamController.value = null;
  }
};

onMounted(() => {
  isUserAtBottom.value = true;

  // 初始化移动端检测
  checkMobile();

  // 监听窗口大小变化
  window.addEventListener('resize', checkMobile);
  window.addEventListener('popstate', handlePopState);
  loadRecentSessions(true);
  const initialSessionId = (() => {
    const match = window.location.pathname.match(/^\/chat\/([^/]+)$/);
    return match ? decodeURIComponent(match[1]) : null;
  })();
  if (initialSessionId) {
    currentSessionId.value = initialSessionId;
    loadSessionMessages(initialSessionId);
  }
});

onUnmounted(() => {
  // 清理事件监听器
  window.removeEventListener('resize', checkMobile);
  window.removeEventListener('popstate', handlePopState);
  if (currentStreamController.value) {
    currentStreamController.value.abort();
  }

  // 恢复 body 滚动（防止移动端打开侧边栏后离开页面）
  // 恢复 body 滚动（防止移动端打开侧边栏后离开页面）
  // 恢复 body 滚动（防止移动端打开侧边栏后离开页面）
  document.body.style.overflow = '';
});
</script>

<style scoped src="../styles/chat-view.css"></style>
<style scoped>
.compression-summary { margin: 0.5rem 0; }
.compression-summary-label {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.5rem 0.75rem;
  background: var(--el-fill-color-light);
  border-radius: 8px;
  cursor: pointer;
  font-size: 0.9rem;
}
.compression-summary-title { font-weight: 500; }
.compression-summary-toggle { color: var(--el-color-primary); font-size: 0.85rem; }
.compression-summary-detail {
  margin-top: 0.5rem;
  padding: 0.75rem;
  background: var(--el-fill-color-lighter);
  border-radius: 8px;
  font-size: 0.9rem;
}
.context-usage-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  /* max-width: 800px; */
  margin: 0 auto 6px;
  padding: 0 8px;
}
.context-usage-label {
  font-size: 0.7rem;
  color: var(--color-text-muted);
  white-space: nowrap;
}
</style>
