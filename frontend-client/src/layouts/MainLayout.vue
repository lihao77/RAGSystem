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
      <component :is="pageShell" :key="isChatRoute ? 'shell-chat' : 'shell-admin'" class="layout-shell">
        <div :class="['route-card', isChatRoute ? 'route-card--chat' : 'route-card--page']">
          <RouterView v-slot="{ Component, route: childRoute }">
            <Transition :name="pageTransitionName" mode="out-in">
              <component
                v-if="Component"
                :is="Component"
                :key="getPageRouteKey(childRoute)"
                v-bind="getChildProps(childRoute)"
              />
            </Transition>
          </RouterView>
        </div>
      </component>
    </div>
    <CommandPalette />
    <HotkeysHelp />
  </div>
</template>

<script setup>
import { Transition, TransitionGroup, computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useThemeStore } from '../stores/theme.js';
import { useDictionariesStore } from '../stores/dictionaries.js';
import { useSessionListStore } from '../stores/session-list.js';
import { deleteSession as deleteSessionApi } from '../api/session';
import { IconLogo, IconChevronLeft, IconChevronRight, IconDocument, IconNewConversation, IconTrash } from '../components/icons';
import { sidebarAdminNavItem, managementNavItems } from '../navigation/adminNavigation';
import CommandPalette from '../components/CommandPalette.vue';
import { useCommandPalette } from '../composables/useCommandPalette.js';
import HotkeysHelp from '../components/HotkeysHelp.vue';
import { useGlobalHotkeys } from '../composables/useGlobalHotkeys.js';
import AdminLayout from './AdminLayout.vue';

const router = useRouter();
const route = useRoute();
const historyListRef = ref(null);
const toast = useToast();
const { confirm } = useConfirm();
const dictStore = useDictionariesStore();
const sessionListStore = useSessionListStore();
const { items: history, loading: historyLoading, loadingMore: historyLoadingMore, error: historyError, hasMore: historyHasMore } = storeToRefs(sessionListStore);
const sidebarCollapsed = ref(localStorage.getItem('sidebarCollapsed') === 'true');
const mobileOpen = ref(false);
const isMobile = ref(false);
const activeTeam = ref('');
const lastChatSessionId = ref(null);

const isChatRoute = computed(() => (route.meta?.mainView || 'chat') === 'chat');
const pageShell = computed(() => (isChatRoute.value ? 'div' : AdminLayout));
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
// 侧栏在所有路由下于同一断点（lg 900px）切抽屉/固定，避免切页时行为不一致。
const sidebarOverlayBreakpoint = 900;

const showToast = (message, actionOrType = null, actionLabel = '重试') => {
  let type = 'error';
  let action = null;
  if (typeof actionOrType === 'string') {
    type = actionOrType;
  } else if (typeof actionOrType === 'function') {
    action = actionOrType;
  }
  toast.show(message, action || type, actionLabel);
};

const getChildProps = (childRoute) => {
  const mainView = childRoute.meta?.mainView || 'chat';
  if (mainView === 'chat') {
    return {};
  }
  return {
    embedded: true,
    chatReturnPath: chatReturnPath.value,
  };
};

const checkMobile = () => {
  isMobile.value = window.innerWidth < sidebarOverlayBreakpoint;
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
  localStorage.setItem('sidebarCollapsed', String(sidebarCollapsed.value));
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

const handleHistoryItemBeforeLeave = (el) => {
  el.style.height = `${el.offsetHeight}px`;
  el.style.opacity = '1';
  el.style.overflow = 'hidden';
};

const handleHistoryItemLeave = (el, done) => {
  void el.offsetHeight;
  el.style.transition = 'height 200ms var(--ease-out-expo), margin 200ms var(--ease-out-expo), padding 200ms var(--ease-out-expo), opacity 160ms ease';
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
  try {
    await sessionListStore.load({ reset });
  } catch (error) {
    showToast('加载历史列表失败', retryLoadHistory);
  }
};

const retryLoadHistory = () => {
  loadRecentSessions(true);
};

const loadActiveTeam = async () => {
  try {
    const result = await dictStore.ensureTeams();
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

// 全局快捷键：会话相对切换（-1 上一条 / +1 下一条）
const switchSession = (delta) => {
  const items = history.value;
  if (!items.length) return;
  const curId = activeSessionId.value;
  const idx = items.findIndex((i) => i.session_id === curId);
  let next;
  if (idx === -1) {
    next = delta > 0 ? 0 : items.length - 1;
  } else {
    next = idx + delta;
    if (next < 0 || next >= items.length) return;
  }
  const target = items[next];
  if (target) selectSession(target);
};

// 全局快捷键：聚焦输入框（composer textarea 打了 data-composer 标记，零组件耦合）
const focusComposer = () => {
  const el = document.querySelector('[data-composer]');
  if (el && typeof el.focus === 'function') el.focus();
};

const confirmDeleteSession = async (item) => {
  const ok = await confirm({
    title: '删除会话',
    message: `确定要删除会话“${item.title || formatTitle(item) || 'New Conversation'}”吗？此操作不可恢复。`,
    confirmText: '删除',
    danger: true,
  });
  if (!ok) return;
  deleteSession(item.session_id);
};

const deleteSession = async (sessionId) => {
  try {
    await deleteSessionApi(sessionId);
    sessionListStore.remove(sessionId);
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

const { register: registerCommand, installHotkey: installCommandPaletteHotkey, setDynamic: setCommandDynamic } = useCommandPalette();
registerCommand([
  { id: 'cmd-new-chat', title: '新聊天', section: '操作', action: () => startNewChat() },
  { id: 'cmd-toggle-theme', title: '切换主题', subtitle: '深色 / 亮色', section: '操作', action: () => useThemeStore().toggle() },
  { id: 'cmd-goto-chat', title: '前往聊天', section: '导航', action: () => navigateTo('/') },
  ...managementNavItems.map((item) => ({
    id: `cmd-nav-${item.key}`,
    title: item.label,
    subtitle: item.title,
    section: '导航',
    action: () => navigateTo(item.path),
  })),
]);

const { register: registerHotkey, install: installGlobalHotkeys } = useGlobalHotkeys();
registerHotkey([
  { id: 'hk-focus-input', combo: '/', description: '聚焦输入框', group: '操作', action: () => focusComposer() },
  { id: 'hk-new-chat', combo: 'c', description: '新建聊天', group: '操作', action: () => startNewChat() },
  { id: 'hk-goto-chat', combo: 'g c', description: '前往对话', group: '导航', action: () => navigateTo('/') },
  { id: 'hk-goto-admin', combo: 'g a', description: '管理中心', group: '导航', action: () => navigateTo('/admin') },
  { id: 'hk-goto-kb', combo: 'g k', description: '知识库', group: '导航', action: () => navigateTo('/vector-library') },
  { id: 'hk-goto-models', combo: 'g m', description: '模型管理', group: '导航', action: () => navigateTo('/model-providers') },
  { id: 'hk-goto-monitor', combo: 'g o', description: '监控面板', group: '导航', action: () => navigateTo('/monitor') },
  { id: 'hk-prev-session', combo: 'alt+arrowup', description: '上一会话', group: '会话', action: () => switchSession(-1) },
  { id: 'hk-next-session', combo: 'alt+arrowdown', description: '下一会话', group: '会话', action: () => switchSession(1) },
]);

watch(history, (items) => {
  setCommandDynamic('sessions', (items || []).slice(0, 8).map((item) => ({
    id: `session-${item.session_id}`,
    title: item.title || formatTitle(item) || 'New Conversation',
    subtitle: getSessionTeamLabel(item) || undefined,
    section: '会话',
    action: () => selectSession(item),
  })));
}, { deep: false });

onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
  loadActiveTeam();
  loadRecentSessions(true);
  installCommandPaletteHotkey();
  installGlobalHotkeys();
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
  transition: transform var(--duration-base) var(--ease-out-expo), opacity var(--duration-base) ease;
}

.history-list-enter-from {
  opacity: 0;
  transform: translateY(-10px) scale(0.98);
}

.history-list-leave-active {
  pointer-events: none;
}

.chat-layout {
  --sidebar-btn-text-transition-in: opacity var(--duration-base) ease 0.05s;
  --sidebar-btn-text-transition-out: opacity var(--duration-fast) ease;
  display: flex;
  height: 100vh;
  width: 100%;
  max-width: 100%;
  background-color: transparent;
  overflow: hidden;
  padding: 0;
  gap: 0;
}

.sidebar-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.36);
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--duration-base) ease;
  z-index: calc(var(--z-sidebar) - 1);
}

.sidebar-backdrop.active {
  opacity: 1;
  pointer-events: auto;
}

.sidebar {
  box-shadow: none;
  background: var(--surface-sidebar);
  width: var(--sidebar-width);
  border-radius: 0;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  z-index: var(--z-sidebar);
  transition: width var(--transition-normal), transform var(--transition-normal);
  --icon-center-line: 25px;
  border-right: 1px solid var(--color-border);
}

.sidebar.collapsed {
  width: var(--sidebar-collapsed-width);
}

.sidebar-top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--spacing-md) calc(var(--icon-center-line) - 16px);
  padding-bottom: var(--spacing-md);
  transition: all var(--transition-normal);
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
  transition: all var(--transition-normal);
}

.sidebar-logo-icon {
  flex-shrink: 0;
  filter: none;
  transition: opacity var(--transition-normal);
}

.sidebar-logo-wrapper:hover .sidebar-logo-icon {
  filter: none;
}

.sidebar-expand-icon {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  color: var(--color-text-secondary);
  pointer-events: none;
  transition: opacity var(--transition-normal);
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
  transition: all var(--transition-normal);
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
  padding: var(--spacing-sm) calc(var(--icon-center-line) - var(--spacing-sm) - 11px);
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
  transition: all var(--transition-normal);
  white-space: nowrap;
  overflow: hidden;
  width: 100%;
  box-shadow: none;
}

.sidebar-btn .icon {
  flex-shrink: 0;
  color: var(--color-text-primary);
  transition: all var(--transition-normal);
}

.sidebar-btn.active {
  background: var(--color-active-bg);
  color: var(--color-brand-accent);
  box-shadow: none;
  position: relative;
}

.sidebar-btn.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  width: 3px;
  height: 20px;
  border-radius: var(--radius-full);
  background: var(--color-brand-accent);
}

.sidebar-btn.active .icon {
  color: var(--color-brand-accent);
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
  gap: 2px;
  min-width: 0;
  margin-top: var(--spacing-sm);
  padding: var(--spacing-sm);
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
  transition: opacity var(--transition-normal), max-height var(--transition-normal);
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
  margin: var(--spacing-sm) var(--spacing-md);
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
  padding: var(--spacing-xs) var(--spacing-sm);
  margin: 0 var(--spacing-sm);
  margin-bottom: 2px;
  border-radius: var(--radius-md);
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: var(--spacing-sm);
  color: var(--color-text-secondary);
  transition: all var(--transition-normal);
  border: 1px solid transparent;
  background: transparent;
  position: relative;
}

.history-item:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
  transform: none;
  box-shadow: none;
}

.history-item.active {
  background: var(--color-active-bg);
  color: var(--color-brand-accent);
  box-shadow: none;
}

.history-item.active .history-icon {
  opacity: 1;
  color: var(--color-brand-accent);
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
  transition: all var(--transition-fast);
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
  transition: all var(--transition-normal);
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
  border-radius: 0;
  box-shadow: none;
}

/* pageShell 包裹层（chat 用 div，管理页用 AdminLayout）——height:100% 让 route-card 滚动容器有确定高度 */
.layout-shell {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
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
  border-radius: 0 var(--radius-xl) var(--radius-xl) 0;
  transform: translateX(-100%);
  width: var(--sidebar-width-mobile);
  background: var(--glass-bg);
  -webkit-backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  backdrop-filter: blur(var(--glass-blur)) saturate(var(--glass-saturate));
  border-right: var(--glass-border-width) var(--glass-border-style) var(--glass-border-color);
  box-shadow: var(--glass-shadow);
}

.chat-layout--sidebar-overlay .sidebar.mobile-open {
  transform: translateX(0);
}

.chat-layout--sidebar-overlay .sidebar.collapsed {
  width: var(--sidebar-width-mobile);
}
</style>
