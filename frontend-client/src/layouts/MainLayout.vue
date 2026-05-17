<template>
  <div class="chat-layout" :class="{ 'chat-layout--sidebar-overlay': isMobile }">
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
        <div class="sidebar-context" :title="sidebarContextTitle">
          <div class="sidebar-context__label">Current</div>
          <div class="sidebar-context__team">{{ currentTeamLabel }}</div>
          <div class="sidebar-context__workspace">{{ currentWorkspaceLabel }}</div>
        </div>
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
          <div v-if="historyLoadingMore" class="history-loading-more g-loading-inline"><span class="g-spinner g-spinner--sm"></span>加载中...</div>
          <div v-if="historyError" class="history-error">
            <span>{{ historyError }}</span>
            <button class="retry-btn" @click="retryLoadHistory">重试</button>
          </div>
        </div>
      </div>

      <div class="sidebar-footer">
        <button
          v-for="item in sidebarNavItems"
          :key="item.key"
          :class="['sidebar-btn', 'sidebar-footer-btn', item.buttonClass, { active: isSidebarNavActive(item) }]"
          :title="item.title"
          @click="navigateTo(item.path)"
        >
          <component :is="item.icon" class="icon" />
          <span class="btn-text">{{ item.label }}</span>
          <span class="sidebar-status__dot"></span>
        </button>
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
import { sidebarAdminNavItem } from '../navigation/adminNavigation';

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
const isSidebarNavActive = (item) => item.section
  ? route.meta?.section === item.section
  : isPageActive(item.mainView);
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
const sidebarNavItems = [sidebarAdminNavItem];
const sidebarOverlayBreakpoint = computed(() => isChatRoute.value ? 768 : 900);

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
  isMobile.value = window.innerWidth < sidebarOverlayBreakpoint.value;
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

watch(sidebarOverlayBreakpoint, checkMobile);

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
const getSessionWorkspaceRoot = (item) => item?.metadata?.workspace_root || '';
const activeSessionItem = computed(() => {
  const sessionId = activeSessionId.value;
  if (!sessionId) return null;
  return history.value.find((item) => item.session_id === sessionId) || null;
});
const currentTeamLabel = computed(() => {
  const team = getSessionTeamLabel(activeSessionItem.value) || activeTeam.value;
  return team ? `Team: ${team}` : 'Team: 未选择';
});
const currentWorkspaceLabel = computed(() => {
  const workspaceRoot = getSessionWorkspaceRoot(activeSessionItem.value);
  return workspaceRoot || '未绑定工作区';
});
const sidebarContextTitle = computed(() => {
  const workspaceRoot = getSessionWorkspaceRoot(activeSessionItem.value);
  return `${currentTeamLabel.value}\n工作区: ${workspaceRoot || '未绑定'}`;
});

const upsertHistoryItem = (item) => {
  if (!item?.session_id) return;
  const normalizedItem = {
    unread_count: 0,
    ...item,
  };
  const existingIndex = history.value.findIndex(entry => entry.session_id === normalizedItem.session_id);
  if (existingIndex >= 0) {
    const existingItem = history.value[existingIndex];
    Object.assign(existingItem, normalizedItem, {
      metadata: { ...(existingItem.metadata || {}), ...(normalizedItem.metadata || {}) },
    });
    if (existingIndex === 0) {
      historyOffset.value = history.value.length;
      return;
    }
    history.value.splice(existingIndex, 1);
    history.value.unshift(existingItem);
  } else {
    history.value.unshift(normalizedItem);
  }
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
  width: 100%;
  max-width: 100%;
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
  background: var(--surface-shell);
  width: 260px;
  border-radius: var(--radius-lg);
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  z-index: var(--z-sidebar);
  transition: width 0.3s var(--ease-default), transform 0.3s ease;
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
  transition: all 0.3s var(--ease-default);
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
  transition: all 0.3s var(--ease-default);
}

.sidebar-logo-icon {
  flex-shrink: 0;
  filter: drop-shadow(0 4px 16px rgba(var(--color-brand-accent-rgb), 0.4));
  transition: opacity 0.3s var(--ease-default), filter 0.3s var(--ease-default);
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
  transition: opacity 0.3s var(--ease-default);
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
  transition: all 0.3s var(--ease-default);
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
  transition: all 0.3s var(--ease-default);
  white-space: nowrap;
  overflow: hidden;
  width: 100%;
  box-shadow: none;
}

.sidebar-btn .icon {
  flex-shrink: 0;
  color: var(--color-text-primary);
  transition: all 0.3s var(--ease-default);
}

.sidebar-btn.active {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-sm),
    inset 0 1px 0 var(--color-soft-inset);
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
.sidebar-btn-monitor,
.sidebar-btn-daemon {
  margin-top: var(--spacing-xs);
}

.sidebar-btn-secondary {
  opacity: 0.8;
}

.sidebar-btn-secondary:hover {
  opacity: 1;
}

.sidebar-context {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  margin-top: var(--spacing-sm);
  padding: 10px;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-hover-overlay);
  transition: opacity var(--transition-fast), max-height var(--transition-fast), padding var(--transition-fast), margin var(--transition-fast);
}

.sidebar-context__label {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: 0;
}

.sidebar-context__team,
.sidebar-context__workspace {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  line-height: 1.35;
}

.sidebar-context__team {
  color: var(--color-text-primary);
  font-size: var(--font-size-sm);
  font-weight: 600;
}

.sidebar-context__workspace {
  color: var(--color-text-secondary);
  font-size: var(--font-size-xs);
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
.sidebar.collapsed .sidebar-context,
.sidebar.collapsed .history-list {
  opacity: 0;
  max-width: 0;
  overflow: hidden;
}

.sidebar.collapsed .sidebar-context {
  max-height: 0;
  margin: 0;
  padding: 0;
  border-color: transparent;
}

.sidebar.collapsed .btn-text {
  transition: var(--sidebar-btn-text-transition-out), max-width 0s ease 0.15s;
}

.history-list {
  flex: 1;
  overflow-y: auto;
  opacity: 1;
  max-height: 100%;
  transition: opacity 0.3s var(--ease-default), max-height 0.3s var(--ease-default);
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
  animation: labelFadeIn 0.4s var(--ease-default) forwards;
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
  transition: all 0.3s var(--ease-default);
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
    inset 0 1px 0 var(--color-soft-inset);
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
  transition: all 0.2s var(--ease-default);
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
  transition: all 0.3s var(--ease-default);
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

.history-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  color: var(--color-text-muted);
  font-size: var(--font-size-sm);
}

.retry-btn {
  margin-left: 8px;
  border: none;
  background: transparent;
  color: var(--color-brand-accent);
  cursor: pointer;
}

.sidebar-footer {
  padding: var(--spacing-md) var(--spacing-sm);
  margin-top: auto;
  border-top: 1px solid var(--color-border);
}

.sidebar-footer-btn {
  margin: 0;
}

.sidebar-footer-btn .sidebar-status__dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  margin-left: auto;
  border-radius: 999px;
  background: var(--color-success);
  box-shadow: 0 0 0 3px rgba(var(--color-success-rgb), 0.12);
  transition: opacity var(--transition-fast), margin var(--transition-fast);
}

.sidebar.collapsed .sidebar-footer-btn .sidebar-status__dot {
  opacity: 0;
  margin-left: -7px;
}

.layout-main-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--surface-shell);
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
  gap: 4px;
  padding: 0 var(--spacing-sm);
}

.skeleton-item {
  height: var(--control-height-md);
  border-radius: var(--radius-lg);
  position: relative;
  overflow: hidden;
}

.skeleton-icon,
.skeleton-line {
  background: var(--color-bg-tertiary);
  opacity: 0.45;
  border-radius: 999px;
}

.skeleton-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
  border-radius: 5px;
}

.skeleton-line {
  flex: 1;
  height: 12px;
}

/* shimmer sweep */
.skeleton-item::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(105deg, transparent 30%, rgba(var(--color-interactive-rgb), 0.035) 45%, rgba(var(--color-interactive-rgb), 0.07) 50%, rgba(var(--color-interactive-rgb), 0.035) 55%, transparent 70%);
  background-size: 250% 100%;
  animation: g-shimmer 2.4s ease-in-out infinite;
  pointer-events: none;
  border-radius: inherit;
}

.skeleton-item:nth-child(2)::after { animation-delay: 0.15s; }
.skeleton-item:nth-child(3)::after { animation-delay: 0.3s; }
.skeleton-item:nth-child(4)::after { animation-delay: 0.4s; }
.skeleton-item:nth-child(5)::after { animation-delay: 0.55s; }
.skeleton-item:nth-child(6)::after { animation-delay: 0.7s; }

.chat-layout--sidebar-overlay {
  padding: 0;
  gap: 0;
}

.chat-layout--sidebar-overlay .sidebar-backdrop {
  background: rgba(6, 8, 12, 0.42);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
}

.chat-layout--sidebar-overlay .sidebar {
  position: fixed;
  left: 0;
  top: 0;
  bottom: 0;
  border-radius: 0 12px 12px 0;
  transform: translateX(-100%);
  width: 280px;
  background: var(--color-bg-elevated);
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-right: 1px solid var(--color-border);
  box-shadow: var(--shadow-lg);
}

.chat-layout--sidebar-overlay .sidebar.mobile-open {
  transform: translateX(0);
}

.chat-layout--sidebar-overlay .sidebar.collapsed {
  width: 280px;
}
</style>
