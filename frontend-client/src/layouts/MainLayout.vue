<template>
  <div class="chat-layout">
    <div class="sidebar-backdrop" :class="{ active: mobileOpen }" @click="closeMobileSidebar"></div>

    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed, 'mobile-open': mobileOpen }">
      <div class="sidebar-top-bar">
        <div class="sidebar-logo-wrapper" @click="toggleSidebar">
          <IconLogo :size="32" class="sidebar-logo-icon" simple />
          <IconChevronRight :size="20" class="sidebar-expand-icon" />
        </div>

        <button class="toggle-sidebar-btn" @click="toggleSidebar" title="Collapse sidebar">
          <IconChevronLeft :size="20" />
        </button>
      </div>

      <div class="sidebar-header">
        <button class="sidebar-btn" @click="startNewChat">
          <IconNewConversation :size="22" class="icon" />
          <span class="btn-text">新聊天</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" @click="goToModelProviders" title="模型 Provider 管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/>
          </svg>
          <span class="btn-text">模型管理</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" @click="goToAgentConfig" title="智能体配置">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/>
          </svg>
          <span class="btn-text">Agent配置</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" @click="goToMCPManager" title="MCP 服务管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <path d="M12 22v-5"/><rect x="6" y="9" width="12" height="6" rx="2"/><path d="M10 9V2"/><path d="M14 9V2"/>
          </svg>
          <span class="btn-text">MCP管理</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" @click="goToVectorLibrary" title="知识库管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
          <span class="btn-text">知识库</span>
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
          <div
            v-for="item in history"
            :key="item.session_id"
            class="history-item"
            :class="{ active: item.session_id === activeSessionId }"
            @click="selectSession(item)"
          >
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

      <div class="sidebar-footer">
        <span class="sidebar-footer__version">RAG Agent System</span>
      </div>
    </aside>

    <div :class="['layout-main-host', { 'layout-main-host--page': !isChatRoute }]">
      <div :class="['route-card', isChatRoute ? 'route-card--chat' : 'route-card--page']">
        <RouterView v-slot="{ Component, route: childRoute }">
          <component
            v-if="Component"
            :is="Component"
            v-bind="getChildProps(childRoute)"
            @update:selectedLLM="emit('update:selectedLLM', $event)"
            @toggle-theme="emit('toggleTheme')"
          />
        </RouterView>
      </div>
    </div>

    <ConfirmDialog
      ref="confirmDialogRef"
      :title="confirmDialog.title"
      :message="confirmDialog.message"
      :confirm-text="confirmDialog.confirmText"
      :cancel-text="confirmDialog.cancelText"
      @confirm="confirmDialog.onConfirm"
      @cancel="confirmDialog.onCancel"
    />
    <AppToast ref="toastRef" />
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import AppToast from '../components/AppToast.vue';
import { IconLogo, IconChevronLeft, IconChevronRight, IconDocument, IconNewConversation, IconTrash } from '../components/icons';

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

const emit = defineEmits(['update:selectedLLM', 'toggleTheme']);

const router = useRouter();
const route = useRoute();
const historyListRef = ref(null);
const confirmDialogRef = ref(null);
const toastRef = ref(null);
const sidebarCollapsed = ref(false);
const mobileOpen = ref(false);
const isMobile = ref(false);
const history = ref([]);
const historyLoading = ref(false);
const historyLoadingMore = ref(false);
const historyError = ref('');
const historyOffset = ref(0);
const historyHasMore = ref(true);
const lastChatSessionId = ref(null);
const confirmDialog = ref({
  title: '确认操作',
  message: '',
  confirmText: '确定',
  cancelText: '取消',
  onConfirm: () => {},
  onCancel: () => {}
});

const isChatRoute = computed(() => (route.meta?.mainView || 'chat') === 'chat');
const activeSessionId = computed(() => {
  if (isChatRoute.value && typeof route.params.id === 'string') {
    return decodeURIComponent(route.params.id);
  }
  return lastChatSessionId.value;
});
const chatReturnPath = computed(() => activeSessionId.value ? `/chat/${encodeURIComponent(activeSessionId.value)}` : '/');

const showToast = (message, actionOrType = null, actionLabel = '重试') => {
  let type = 'error';
  let action = null;
  if (typeof actionOrType === 'string') {
    type = actionOrType;
  } else if (typeof actionOrType === 'function') {
    action = actionOrType;
  }
  toastRef.value?.show(message, action || type, actionLabel);
};

const getChildProps = (childRoute) => {
  const mainView = childRoute.meta?.mainView || 'chat';
  if (mainView === 'chat') {
    return {
      selectedLLM: props.selectedLLM,
      isDark: props.isDark,
    };
  }
  return {
    embedded: true,
    chatReturnPath: chatReturnPath.value,
  };
};

const checkMobile = () => {
  isMobile.value = window.innerWidth < 768;
  if (!isMobile.value) {
    mobileOpen.value = false;
    document.body.style.overflow = '';
  }
};

const openMobileSidebar = () => {
  mobileOpen.value = true;
  document.body.style.overflow = 'hidden';
};

const closeMobileSidebar = () => {
  mobileOpen.value = false;
  document.body.style.overflow = '';
};

provide('shellSidebarControl', {
  openMobileSidebar,
  closeMobileSidebar,
});

const toggleSidebar = () => {
  if (isMobile.value) {
    closeMobileSidebar();
    return;
  }
  sidebarCollapsed.value = !sidebarCollapsed.value;
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
    if (userId) params.set('user_id', userId);
    const response = await fetch(`/api/agent/sessions?${params.toString()}`);
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    const result = await response.json();
    const payload = result.data || {};
    const items = payload.items || [];
    history.value = reset ? items : history.value.concat(items);
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

const handleHistoryScroll = () => {
  if (!historyListRef.value || historyLoadingMore.value || !historyHasMore.value) return;
  const el = historyListRef.value;
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 40) {
    loadRecentSessions(false);
  }
};

const startNewChat = async () => {
  lastChatSessionId.value = null;
  await router.replace('/');
  closeMobileSidebar();
};

const selectSession = async (item) => {
  if (!item?.session_id) return;
  lastChatSessionId.value = item.session_id;
  item.unread_count = 0;
  await router.push(`/chat/${encodeURIComponent(item.session_id)}`);
  closeMobileSidebar();
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
    history.value = history.value.filter(item => item.session_id !== sessionId);
    if (activeSessionId.value === sessionId) {
      await startNewChat();
    }
    showToast('会话已删除', 'success');
  } catch (error) {
    showToast(error.message || '删除会话失败');
  }
};

const goToMonitor = () => router.push('/monitor');
const goToAgentConfig = () => router.push('/agent-config');
const goToMCPManager = () => router.push('/mcp');
const goToVectorLibrary = () => router.push('/vector-library');
const goToModelProviders = () => router.push('/model-providers');

watch(
  () => [route.meta?.mainView || 'chat', route.params.id || null],
  async ([mainView, routeSessionId], previous = []) => {
    const [prevMainView, prevRouteSessionId] = previous;
    if (mainView === 'chat') {
      lastChatSessionId.value = typeof routeSessionId === 'string' ? decodeURIComponent(routeSessionId) : null;
    }
    if (mainView === 'chat' && routeSessionId !== prevRouteSessionId) {
      await loadRecentSessions(true);
    } else if (mainView !== prevMainView && mainView !== 'chat') {
      await loadRecentSessions(true);
    }
  },
  { immediate: true }
);

onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
  document.body.style.overflow = '';
});
</script>

<style scoped>
.chat-layout {
  display: flex;
  height: 100vh;
  width: 100vw;
  background-color: transparent;
  overflow: hidden;
  padding: 6px;
  gap: 6px;
}

.sidebar-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.36);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s ease;
  z-index: calc(var(--z-sidebar) - 1);
}

.sidebar-backdrop.active {
  opacity: 1;
  pointer-events: auto;
}

.sidebar {
  width: 260px;
  background: var(--glass-bg);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--color-glass-border);
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  z-index: var(--z-sidebar);
  transition: width 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), transform 0.3s ease;
  --icon-center-line: 25px;
}

.sidebar.collapsed {
  width: calc(2 * var(--icon-center-line) + 1px);
}

.sidebar-top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) calc(var(--icon-center-line) - 16px);
  padding-bottom: var(--spacing-md);
}

.sidebar-logo-wrapper {
  position: relative;
  width: 32px;
  height: 32px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: left;
  flex: 1;
}

.sidebar-logo-icon {
  flex-shrink: 0;
  filter: drop-shadow(0 4px 16px rgba(var(--color-brand-accent-rgb), 0.4));
}

.sidebar-expand-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  color: var(--color-text-secondary);
  pointer-events: none;
}

.sidebar.collapsed .sidebar-logo-wrapper:hover .sidebar-logo-icon {
  opacity: 0;
}

.sidebar.collapsed .sidebar-logo-wrapper:hover .sidebar-expand-icon {
  opacity: 1;
}

.toggle-sidebar-btn {
  width: 32px;
  height: 32px;
  min-width: 32px;
  padding: 6px;
  background: none;
  color: var(--color-text-secondary);
  border: none;
  border-radius: var(--radius-lg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sidebar.collapsed .toggle-sidebar-btn {
  opacity: 0;
  width: 0;
  min-width: 0;
  padding: 0;
  pointer-events: none;
}

.sidebar-header {
  margin-bottom: var(--spacing-lg);
  padding: 0 var(--spacing-sm);
}

.sidebar-btn {
  margin: 0;
  padding: 12px calc(var(--icon-center-line) - var(--spacing-sm) - 11px);
  background: none;
  color: var(--color-text-primary);
  border: none;
  border-radius: var(--radius-lg);
  font-weight: 500;
  font-size: var(--font-size-base);
  display: flex;
  align-items: center;
  justify-content: left;
  gap: var(--spacing-sm);
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
  width: 100%;
}

.sidebar-btn:hover,
.toggle-sidebar-btn:hover,
.history-item:hover {
  background: var(--color-bg-secondary);
}

.sidebar-btn-secondary,
.sidebar-btn-monitor {
  margin-top: var(--spacing-xs);
}

.btn-text {
  overflow: hidden;
  white-space: nowrap;
}

.sidebar.collapsed .btn-text,
.sidebar.collapsed .sidebar-footer__version,
.sidebar.collapsed .history-list {
  opacity: 0;
  max-width: 0;
  overflow: hidden;
}

.history-list {
  flex: 1;
  overflow-y: auto;
}

.history-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin: var(--spacing-md);
  letter-spacing: 0.08em;
  padding-left: var(--spacing-xs);
}

.history-item {
  padding: 10px var(--spacing-sm);
  margin: 0 var(--spacing-sm);
  margin-bottom: 2px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  color: var(--color-text-secondary);
}

.history-item.active {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
}

.history-main {
  flex: 1;
  min-width: 0;
}

.history-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-xs);
}

.history-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
}

.history-time {
  flex-shrink: 0;
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.history-delete-btn {
  width: 0;
  padding: 0;
  overflow: hidden;
  opacity: 0;
  pointer-events: none;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--color-text-muted);
  cursor: pointer;
  flex-shrink: 0;
}

@media (hover: hover) {
  .history-item:hover .history-delete-btn {
    width: 32px;
    padding: 6px;
    opacity: 1;
    pointer-events: auto;
  }
}

.history-error,
.history-loading-more {
  padding: 12px 16px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.retry-btn {
  margin-left: 8px;
  border: none;
  background: transparent;
  color: var(--color-brand-primary);
  cursor: pointer;
}

.sidebar-footer {
  padding: var(--spacing-md) var(--spacing-lg);
  margin-top: auto;
  border-top: 1px solid var(--color-border);
  display: flex;
  align-items: center;
  justify-content: center;
}

.sidebar-footer__version {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
}

.layout-main-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
  backdrop-filter: blur(var(--glass-blur));
  -webkit-backdrop-filter: blur(var(--glass-blur));
  border: 1px solid var(--color-glass-border);
  border-radius: var(--radius-lg);
}

.layout-main-host--page {
  overflow-y: auto;
  overflow-x: hidden;
}

.route-card {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
}

.route-card--chat {
  display: flex;
  overflow: hidden;
}

.route-card--chat > * {
  flex: 1;
  min-width: 0;
  min-height: 0;
}

.route-card--page {
  overflow: visible;
}

.history-skeleton {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0 var(--spacing-sm);
}

.skeleton-item {
  height: 44px;
  opacity: 0.75;
}

.skeleton-icon,
.skeleton-line {
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.5);
  border-radius: 999px;
}

.skeleton-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.skeleton-line {
  flex: 1;
  height: 12px;
}

@media (max-width: 767px) {
  .chat-layout {
    padding: 0;
    gap: 0;
  }

  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 0 18px 18px 0;
    transform: translateX(-100%);
    width: 280px;
  }

  .sidebar.mobile-open {
    transform: translateX(0);
  }

  .sidebar.collapsed {
    width: 280px;
  }
}
</style>
