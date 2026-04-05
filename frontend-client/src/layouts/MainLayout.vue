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
        <button class="sidebar-btn" :class="{ active: isPageActive('chat') && !activeSessionId }" @click="startNewChat">
          <IconNewConversation :size="22" class="icon" />
          <span class="btn-text">新聊天</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" :class="{ active: isPageActive('model-providers') }" @click="goToModelProviders" title="模型 Provider 管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/><path d="M4.93 4.93a10 10 0 0 0 0 14.14"/>
          </svg>
          <span class="btn-text">模型管理</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" :class="{ active: isPageActive('team-builder') }" @click="goToTeamBuilder" title="Team 方案编排">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="14" y="15" width="7" height="7" rx="1"/><path d="M10 7h4"/><path d="M17.5 11v4"/>
          </svg>
          <span class="btn-text">Team编排</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" :class="{ active: isPageActive('agent-config') }" @click="goToAgentConfig" title="智能体配置">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z"/>
          </svg>
          <span class="btn-text">Agent配置</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" :class="{ active: isPageActive('mcp') }" @click="goToMCPManager" title="MCP 服务管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <path d="M12 22v-5"/><rect x="6" y="9" width="12" height="6" rx="2"/><path d="M10 9V2"/><path d="M14 9V2"/>
          </svg>
          <span class="btn-text">MCP管理</span>
        </button>
        <button class="sidebar-btn sidebar-btn-secondary" :class="{ active: isPageActive('vector-library') }" @click="goToVectorLibrary" title="知识库管理">
          <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="icon">
            <ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
          </svg>
          <span class="btn-text">知识库</span>
        </button>
        <button class="sidebar-btn sidebar-btn-monitor" :class="{ active: isPageActive('monitor') }" @click="goToMonitor" title="智能体性能监控">
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
          <TransitionGroup
            name="history-list"
            tag="div"
            class="history-list-group"
            @before-leave="handleHistoryItemBeforeLeave"
            @leave="handleHistoryItemLeave"
            @after-leave="handleHistoryItemAfterLeave"
          >
            <div
              v-for="item in history"
              :key="item.session_id"
              class="history-item"
              :class="{ active: isChatRoute && item.session_id === activeSessionId }"
              @click="selectSession(item)"
            >
              <IconDocument :size="18" class="history-icon" />
              <div class="history-main">
                <div class="history-title-row">
                  <span class="history-title">{{ item.title || formatTitle(item) || 'New Conversation' }}</span>
                  <span class="history-time">{{ formatTimeLabel(item.last_message_at) }}</span>
                </div>
                <div class="history-meta">
                  <div v-if="getSessionTeamLabel(item)" class="history-meta-details">
                    <span class="history-meta-chip" :title="`所属 Team: ${getSessionTeamLabel(item)}`">
                      Team: {{ getSessionTeamLabel(item) }}
                    </span>
                  </div>
                  <span v-if="item.unread_count > 0" class="history-unread">{{ item.unread_count }}</span>
                </div>
              </div>
              <button class="history-delete-btn" @click.stop="confirmDeleteSession(item)" title="删除会话">
                <IconTrash :size="16" />
              </button>
            </div>
          </TransitionGroup>
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
          <Transition :name="pageTransitionName" mode="out-in">
            <component
              v-if="Component"
              :is="Component"
              :key="getPageRouteKey(childRoute)"
              v-bind="getChildProps(childRoute)"
              @update:selectedLLM="emit('update:selectedLLM', $event)"
              @toggle-theme="emit('toggleTheme')"
            />
          </Transition>
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
import { Transition, TransitionGroup, computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import ConfirmDialog from '../components/ConfirmDialog.vue';
import AppToast from '../components/AppToast.vue';
import { getTeams } from '../api/agentConfig';
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
const activeTeam = ref('');
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
const isPageActive = (mainView) => (route.meta?.mainView || 'chat') === mainView;
const pageTransitionName = ref('slide-forward');
const activeSessionId = computed(() => {
  if (isChatRoute.value && typeof route.params.id === 'string') {
    return decodeURIComponent(route.params.id);
  }
  return lastChatSessionId.value;
});
const chatReturnPath = computed(() => activeSessionId.value ? `/chat/${encodeURIComponent(activeSessionId.value)}` : '/');
const getPageDepth = (targetRoute) => targetRoute.meta?.depth ?? 0;
const getPageOrder = (targetRoute) => targetRoute.meta?.pageOrder ?? getPageDepth(targetRoute);
const getPageRouteKey = (targetRoute) => targetRoute.meta?.pageKey || targetRoute.meta?.mainView || 'chat';

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
      onSessionCreated: upsertHistoryItem,
      onSessionUpdated: upsertHistoryItem,
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

const getSessionTeamLabel = (item) => item?.metadata?.team || '';

const upsertHistoryItem = (item) => {
  if (!item?.session_id) return;
  const normalizedItem = {
    unread_count: 0,
    ...item,
  };
  const existingIndex = history.value.findIndex(entry => entry.session_id === normalizedItem.session_id);
  if (existingIndex >= 0) {
    history.value.splice(existingIndex, 1);
  }
  history.value.unshift(normalizedItem);
  historyOffset.value = history.value.length;
};

const handleHistoryItemBeforeLeave = (el) => {
  el.style.height = `${el.offsetHeight}px`;
  el.style.opacity = '1';
  el.style.overflow = 'hidden';
};

const handleHistoryItemLeave = (el, done) => {
  void el.offsetHeight;
  el.style.transition = 'height 0.24s cubic-bezier(0.22, 1, 0.36, 1), margin 0.24s cubic-bezier(0.22, 1, 0.36, 1), padding 0.24s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.18s ease';
  el.style.height = '0';
  el.style.marginTop = '0';
  el.style.marginBottom = '0';
  el.style.paddingTop = '0';
  el.style.paddingBottom = '0';
  el.style.opacity = '0';
  window.setTimeout(done, 240);
};

const handleHistoryItemAfterLeave = (el) => {
  el.style.height = '';
  el.style.opacity = '';
  el.style.overflow = '';
  el.style.transition = '';
  el.style.marginTop = '';
  el.style.marginBottom = '';
  el.style.paddingTop = '';
  el.style.paddingBottom = '';
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
    const params = new URLSearchParams({
      limit: String(20),
      offset: String(historyOffset.value)
    });
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

const loadActiveTeam = async () => {
  try {
    const result = await getTeams();
    activeTeam.value = result?.active_team || '';
  } catch (error) {
    console.warn('加载当前 Team 失败:', error);
  }
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

const navigateTo = async (path) => {
  await router.push(path);
  if (isMobile.value) {
    closeMobileSidebar();
  }
};

const goToMonitor = () => navigateTo('/monitor');
const goToTeamBuilder = () => navigateTo('/team-builder');
const goToAgentConfig = () => navigateTo('/agent-config');
const goToMCPManager = () => navigateTo('/mcp');
const goToVectorLibrary = () => navigateTo('/vector-library');
const goToModelProviders = () => navigateTo('/model-providers');

watch(
  () => route.fullPath,
  (toFullPath, fromFullPath) => {
    if (!fromFullPath) {
      pageTransitionName.value = 'slide-forward';
      return;
    }
    const resolvedFrom = router.resolve(fromFullPath);
    const toKey = getPageRouteKey(route);
    const fromKey = getPageRouteKey(resolvedFrom);
    if (toKey === fromKey) {
      pageTransitionName.value = 'slide-forward';
      return;
    }
    const toOrder = getPageOrder(route);
    const fromOrder = getPageOrder(resolvedFrom);
    pageTransitionName.value = toOrder >= fromOrder ? 'slide-forward' : 'slide-backward';
  },
  { immediate: true }
);

watch(
  () => [route.meta?.mainView || 'chat', route.params.id || null],
  ([mainView, routeSessionId]) => {
    if (mainView === 'chat') {
      lastChatSessionId.value = typeof routeSessionId === 'string' ? decodeURIComponent(routeSessionId) : null;
    }
  },
  { immediate: true }
);

onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
  loadActiveTeam();
  loadRecentSessions(true);
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
  document.body.style.overflow = '';
});
</script>

<style scoped>
.history-list-group {
  position: relative;
}

.history-list-move,
.history-list-enter-active {
  transition: transform 0.28s cubic-bezier(0.22, 1, 0.36, 1), opacity 0.22s ease;
}

.history-list-enter-from {
  opacity: 0;
  transform: translateY(-10px) scale(0.98);
}

.history-list-leave-active {
  pointer-events: none;
}

.chat-layout {
  --sidebar-btn-text-transition-in: opacity 0.25s ease 0.05s;
  --sidebar-btn-text-transition-out: opacity 0.15s ease;
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
  box-shadow: var(--shadow-sm);
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
  width: 260px;
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
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.sidebar.collapsed .sidebar-top-bar {
  justify-content: center;
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
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.sidebar-logo-icon {
  flex-shrink: 0;
  filter: drop-shadow(0 4px 16px rgba(var(--color-brand-accent-rgb), 0.4));
  transition: opacity 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), filter 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.sidebar-logo-wrapper:hover .sidebar-logo-icon {
  filter: drop-shadow(0 6px 24px rgba(var(--color-brand-accent-rgb), 0.6));
}

.sidebar-expand-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  color: var(--color-text-secondary);
  pointer-events: none;
  transition: opacity 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.sidebar:not(.collapsed) .sidebar-logo-icon {
  opacity: 1;
}

.sidebar:not(.collapsed) .sidebar-expand-icon {
  opacity: 0;
}

.sidebar.collapsed .sidebar-logo-icon {
  opacity: 1;
}

.sidebar.collapsed .sidebar-expand-icon {
  opacity: 0;
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
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  flex-shrink: 0;
  opacity: 1;
  max-width: 32px;
  overflow: hidden;
}

.sidebar.collapsed .toggle-sidebar-btn {
  opacity: 0;
  max-width: 0;
  min-width: 0;
  width: 0;
  padding: 0;
  margin: 0;
  pointer-events: none;
}

.toggle-sidebar-btn:hover {
  background: var(--color-bg-tertiary);
  border-color: var(--color-border);
  color: var(--color-text-primary);
  transform: scale(1.05);
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
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  white-space: nowrap;
  overflow: hidden;
  width: 100%;
  box-shadow: none;
}

.sidebar-btn .icon {
  flex-shrink: 0;
  color: var(--color-text-primary);
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.sidebar-btn.active {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-sm),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.sidebar-btn.active .icon {
  color: var(--color-text-primary);
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

.sidebar-btn-secondary {
  opacity: 0.8;
}

.sidebar-btn-secondary:hover {
  opacity: 1;
}

.btn-text {
  overflow: hidden;
  white-space: nowrap;
  opacity: 1;
  max-width: 200px;
  transition: var(--sidebar-btn-text-transition-in);
  will-change: opacity;
}

.sidebar.collapsed .btn-text,
.sidebar.collapsed .sidebar-footer__version,
.sidebar.collapsed .history-list {
  opacity: 0;
  max-width: 0;
  overflow: hidden;
}

.sidebar.collapsed .btn-text {
  transition: var(--sidebar-btn-text-transition-out), max-width 0s ease 0.15s;
}

.history-list {
  flex: 1;
  overflow-y: auto;
  opacity: 1;
  max-height: 100%;
  transition: opacity 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94), max-height 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.sidebar.collapsed .history-list {
  opacity: 0;
  max-height: 0;
  overflow: hidden;
  padding: 0;
  margin: 0;
}

.history-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: uppercase;
  color: var(--color-text-muted);
  margin: var(--spacing-md);
  letter-spacing: 0.08em;
  padding-left: var(--spacing-xs);
  opacity: 0;
  animation: labelFadeIn 0.4s cubic-bezier(0.25, 0.46, 0.45, 0.94) forwards;
  animation-delay: 0.1s;
}

@keyframes labelFadeIn {
  from {
    opacity: 0;
    transform: translateX(-10px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
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
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
  border: 1px solid transparent;
  background: transparent;
  position: relative;
}

.history-item:hover {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  transform: translateX(2px);
  box-shadow: var(--shadow-sm);
}

.history-item.active {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-sm),
    inset 0 1px 0 rgba(255, 255, 255, 0.06);
}

.history-item.active .history-icon {
  opacity: 1;
  color: var(--color-text-primary);
}

.history-main {
  flex: 1;
  min-width: 0;
}

.history-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  opacity: 0.7;
  color: var(--color-text-secondary);
  transition: all 0.2s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.history-item:hover .history-icon {
  opacity: 1;
  color: var(--color-text-primary);
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

.history-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-xs);
  margin-top: 4px;
  min-width: 0;
}

.history-meta-details {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 6px;
  flex-wrap: wrap;
}

.history-meta-chip {
  max-width: 100%;
  min-width: 0;
  font-size: 11px;
  line-height: 1.4;
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.history-meta-chip--path {
  flex: 1;
}

.history-unread {
  flex-shrink: 0;
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
  transition: all 0.3s cubic-bezier(0.25, 0.46, 0.45, 0.94);
}

.history-delete-btn:hover {
  background: rgba(239, 68, 68, 0.12);
  color: var(--color-error);
  transform: scale(1.1);
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

.sidebar.collapsed .sidebar-footer {
  padding: var(--spacing-md) calc(var(--icon-center-line) - 16px);
}

.sidebar-footer__version {
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  transition: opacity 0.3s;
}

.layout-main-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.42);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-sm);
}

.layout-main-host--page {
  overflow: hidden;
}

.route-card {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  position: relative;
  overflow: hidden;
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
  min-height: 100%;
  height: 100%;
  overflow: hidden;
}

.route-card--page > * {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
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

  .sidebar-backdrop {
    background: rgba(6, 8, 12, 0.36);
    backdrop-filter: blur(8px);
    -webkit-backdrop-filter: blur(8px);
  }

  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    border-radius: 0 18px 18px 0;
    transform: translateX(-100%);
    width: 280px;
    background: rgba(var(--color-bg-elevated-rgb, 28, 28, 30), 0.84);
    backdrop-filter: blur(20px) saturate(150%);
    -webkit-backdrop-filter: blur(20px) saturate(150%);
    border-right: 1px solid rgba(255, 255, 255, 0.08);
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.32);
  }

  .sidebar.mobile-open {
    transform: translateX(0);
  }

  .sidebar.collapsed {
    width: 280px;
  }
}
</style>
