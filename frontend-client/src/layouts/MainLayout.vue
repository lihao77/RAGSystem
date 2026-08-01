<template>
  <div class="chat-layout" :class="{ 'chat-layout--sidebar-overlay': isMobile }">
    <div class="sidebar-backdrop" :class="{ active: mobileOpen }" @click="closeMobileSidebar"></div>

    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed, 'mobile-open': mobileOpen }">
      <div class="sidebar-top-bar">
        <div class="sidebar-logo-wrapper" @click="toggleSidebar">
          <IconLogo :size="32" class="sidebar-logo-icon" simple />
          <IconChevronRight :size="20" class="sidebar-expand-icon" />
        </div>

        <Button class="toggle-sidebar-btn" variant="ghost" size="icon" aria-label="折叠侧栏" title="Collapse sidebar" @click="toggleSidebar">
          <IconChevronLeft :size="20" />
        </Button>
      </div>

      <Transition name="sidebar-mode" mode="out-in">
        <div v-if="isChatRoute" key="chat" class="sidebar-mode">
      <div class="sidebar-header">
        <button class="sidebar-btn" :class="{ active: isPageActive('chat') && !activeSessionId }" @click="startNewChat">
          <IconNewConversation class="icon" />
          <span class="btn-text">新聊天</span>
        </button>
      </div>

      <SessionList
        v-show="!sidebarCollapsed || isMobile"
        :active-session-id="activeSessionId"
        @select="selectSession"
        @delete="confirmDeleteSession"
      />
        </div>

        <div v-else key="admin" class="sidebar-mode">
        <div class="admin-nav-list">
          <button
            v-if="canViewAdminOverview"
            class="sidebar-btn admin-nav-item admin-nav-overview"
            :class="{ active: isPageActive(sidebarAdminNavItem.mainView) }"
            :title="sidebarAdminNavItem.title"
            @click="navigateTo(sidebarAdminNavItem.path)"
          >
            <component :is="sidebarAdminNavItem.icon" class="icon" />
            <span class="btn-text">{{ sidebarAdminNavItem.label }}</span>
          </button>
          <div v-for="group in visibleAdminNavGroups" :key="group.key" class="admin-nav-group">
            <div class="admin-nav-group-label">{{ group.label }}</div>
            <button
              v-for="item in adminItemsByGroup(group.key)"
              :key="item.key"
              class="sidebar-btn admin-nav-item"
              :class="{ active: isPageActive(item.mainView) }"
              :title="item.title"
              @click="navigateTo(item.path)"
            >
              <component :is="item.icon" class="icon" />
              <span class="btn-text">{{ item.label }}</span>
            </button>
          </div>
        </div>
        </div>
      </Transition>

      <div class="sidebar-footer">
        <UserMenu />
        <button
          class="footer-toggle-btn"
          :title="isChatRoute ? '管理中心' : '返回聊天'"
          :aria-label="isChatRoute ? '管理中心' : '返回聊天'"
          @click="navigateTo(isChatRoute ? managementEntryPath : '/')"
        >
          <component :is="isChatRoute ? sidebarAdminNavItem.icon : IconChevronLeft" :size="22" />
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

    <Dialog :open="promptDialogVisible" @update:open="(v) => { if (!v) promptDialogVisible = false }">
      <DialogContent class="max-w-[480px]">
        <DialogHeader>
          <DialogTitle>{{ activePrompt?.name }}</DialogTitle>
          <p class="text-sm text-muted-foreground">{{ activePrompt?.description }}</p>
        </DialogHeader>
        <div v-if="activePrompt" class="mcp-prompt-args">
          <label v-for="arg in activePrompt.arguments" :key="arg.name" class="field">
            <span>{{ arg.name }}<em v-if="arg.required">*</em></span>
            <Input v-model="promptArgs[arg.name]" :placeholder="arg.description || ''" />
          </label>
        </div>
        <DialogFooter>
          <Button size="sm" @click="promptDialogVisible = false">取消</Button>
          <Button size="sm" variant="default" @click="submitPromptArgs">生成内容</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, onUnmounted, provide, ref, watch } from 'vue';
import { RouterView, useRoute, useRouter } from 'vue-router';
import { storeToRefs } from 'pinia';
import { useToast } from '../composables/useToast.js';
import { useConfirm } from '../composables/useConfirm.js';
import { useThemeStore } from '../stores/theme.js';
import { useSessionListStore } from '../stores/session-list.js';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { useAuthStore } from '../stores/auth.js';
import { usePermission } from '../composables/usePermission.js';
import { destroyFrontendChatSdk, getFrontendChatSdk } from '../composables/chatSdkClient.js';
import { IconLogo, IconChevronLeft, IconChevronRight, IconNewConversation } from '../components/icons';
import { Button } from '../components/ui/button';
import UserMenu from '../components/UserMenu.vue';
import SessionList from '../components/session-list/SessionList.vue';
import { sidebarAdminNavItem, filterManagementNavItems, adminNavGroups } from '../navigation/adminNavigation';
import CommandPalette from '../components/CommandPalette.vue';
import { useCommandPalette } from '../composables/useCommandPalette.js';
import HotkeysHelp from '../components/HotkeysHelp.vue';
import { useGlobalHotkeys } from '../composables/useGlobalHotkeys.js';
import AdminLayout from './AdminLayout.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { getMCPServerPrompt } from '../api/mcpService';
import { useMcpStore } from '../stores/mcp.js';

const router = useRouter();
const route = useRoute();
const toast = useToast();
const { confirm } = useConfirm();
const sessionListStore = useSessionListStore();
const chatSdkClient = getFrontendChatSdk();
sessionListStore.setChatSdkClient(chatSdkClient);
provide('chatSdkClient', chatSdkClient);
const bootstrapStore = useBootstrapStore();
const authStore = useAuthStore();
const { isPlatformAdmin, hasTenantRole } = usePermission();
const { items: history } = storeToRefs(sessionListStore);
const sidebarCollapsed = ref(localStorage.getItem('sidebarCollapsed') === 'true');
const mobileOpen = ref(false);
const isMobile = ref(false);
const lastChatSessionId = ref(null);

const isChatRoute = computed(() => (route.meta?.mainView || 'chat') === 'chat');
const pageShell = computed(() => (isChatRoute.value ? 'div' : AdminLayout));
const isPageActive = (mainView) => (route.meta?.mainView || 'chat') === mainView;
const visibleManagementNavItems = computed(() => filterManagementNavItems(bootstrapStore.capabilities, {
  isAuthenticated: authStore.isAuthenticated,
  authMode: bootstrapStore.profile.auth,
  isLocal: bootstrapStore.profile.ui === 'local' || bootstrapStore.profile.deployment === 'local',
  isPlatformAdmin: isPlatformAdmin.value,
  hasTenantRole,
}));
const adminItemsByGroup = (groupKey) => visibleManagementNavItems.value.filter((i) => i.group === groupKey);
const visibleAdminNavGroups = computed(() => adminNavGroups.filter((group) => adminItemsByGroup(group.key).length > 0));
const canViewAdminOverview = computed(() => hasTenantRole(sidebarAdminNavItem.requireTenantRole));
const managementEntryPath = computed(() => canViewAdminOverview.value
  ? sidebarAdminNavItem.path
  : visibleManagementNavItems.value[0]?.path || '/');
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
provide('sidebarCollapsed', sidebarCollapsed);

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
    await chatSdkClient.deleteSession(sessionId);
    sessionListStore.remove(sessionId);
    void sessionListStore.loadFacets();
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
  ...visibleManagementNavItems.value.map((item) => ({
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
  { id: 'hk-goto-admin', combo: 'g a', description: '管理中心', group: '导航', action: () => navigateTo(managementEntryPath.value) },
  ...(hasTenantRole('admin') ? [
    { id: 'hk-goto-kb', combo: 'g k', description: '知识库', group: '导航', action: () => navigateTo('/knowledge-base') },
    { id: 'hk-goto-models', combo: 'g m', description: '模型管理', group: '导航', action: () => navigateTo('/model-providers') },
    { id: 'hk-goto-monitor', combo: 'g o', description: '监控面板', group: '导航', action: () => navigateTo('/monitor') },
  ] : []),
  { id: 'hk-prev-session', combo: 'alt+arrowup', description: '上一会话', group: '会话', action: () => switchSession(-1) },
  { id: 'hk-next-session', combo: 'alt+arrowdown', description: '下一会话', group: '会话', action: () => switchSession(1) },
]);

watch(history, (items) => {
  setCommandDynamic('sessions', (items || []).slice(0, 8).map((item) => ({
    id: `session-${item.session_id}`,
    title: item.title || formatTitle(item) || 'New Conversation',
    subtitle: item.origin.type === 'direct'
      ? item.workspace?.display_name || undefined
      : `${item.origin.display_name} · ${item.workspace?.display_name || item.origin.channel}`,
    section: '会话',
    action: () => selectSession(item),
  })));
}, { deep: false });

const promptDialogVisible = ref(false);
const activePrompt = ref(null);
const promptArgs = ref({});

const mcpStore = useMcpStore();
// MCP prompts 走 store:MCPManager 的 server 变更触发 store.reloadPrompts,这里 watch 自动重注册命令面板。
watch(() => mcpStore.prompts, (prompts) => {
  setCommandDynamic('mcp-prompts', (prompts || []).map((p) => ({
    id: `mcp-prompt-${p.server_name}-${p.name}`,
    title: p.name,
    subtitle: `MCP · ${p.server_name}`,
    section: '提示词',
    keywords: p.description || '',
    action: () => useMcpPrompt(p),
  })));
}, { immediate: true });

function useMcpPrompt(prompt) {
  if (!prompt.arguments?.length) {
    fetchAndCopyPrompt(prompt.server_name, prompt.name, {});
    return;
  }
  activePrompt.value = prompt;
  promptArgs.value = Object.fromEntries((prompt.arguments || []).map((a) => [a.name, '']));
  promptDialogVisible.value = true;
}

async function fetchAndCopyPrompt(serverName, name, args) {
  try {
    const res = await getMCPServerPrompt(serverName, name, args);
    const messages = res.data?.messages || [];
    const text = messages.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n\n').trim();
    if (!text) { toast.warning('该提示词未返回内容'); return; }
    await navigator.clipboard.writeText(text);
    toast.success(`提示词 "${name}" 内容已复制,粘贴到对话框发送`);
  } catch { /* toast 已由 http 层处理 */ }
}

async function submitPromptArgs() {
  const prompt = activePrompt.value;
  if (!prompt) return;
  promptDialogVisible.value = false;
  await fetchAndCopyPrompt(prompt.server_name, prompt.name, { ...promptArgs.value });
}

onMounted(() => {
  checkMobile();
  window.addEventListener('resize', checkMobile);
  mcpStore.reloadPrompts();
  installCommandPaletteHotkey();
  installGlobalHotkeys();
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
  document.body.style.overflow = '';
  sessionListStore.setChatSdkClient(null);
  destroyFrontendChatSdk();
});
</script>

<style scoped>
.mcp-prompt-args { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.mcp-prompt-args .field { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-size-sm); }
.mcp-prompt-args .field span { color: var(--color-text-secondary); }
.mcp-prompt-args .field em { color: var(--color-error); font-style: normal; margin-left: 2px; }
.chat-layout {
  --sidebar-btn-text-transition-in: opacity var(--duration-base) ease 0.05s;
  --sidebar-btn-text-transition-out: opacity var(--duration-fast) ease;
  display: flex;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 100%;
  background-color: var(--surface-sidebar);
  overflow: hidden;
  padding: 0;
  gap: 0;
}

/* scrim 透明度统一取 0.42（与下方 overlay 布局分支一致，全文件单一取值） */
.sidebar-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(var(--color-scrim-rgb), 0.42);
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
  --sidebar-icon-size: 18px;
  /* border-right: 1px solid var(--color-border); */
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
  /* 过渡对齐 shadcn ghost 按钮手感（transition-colors），max-width 折叠动画走 fast 与 ghost 一致 */
  transition: background var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast), transform var(--transition-fast), max-width var(--transition-fast), padding var(--transition-fast);
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
  /* 手感对齐 ghost：仅换背景与文字色，去掉 scale 弹跳（hover 背景已由上面统一规则提供） */
  border-color: var(--color-border);
  color: var(--color-text-primary);
}

.sidebar-header {
  margin-bottom: var(--spacing-lg);
  padding: 0 var(--spacing-sm);
}
.sidebar.collapsed .sidebar-header { margin-bottom: 0; }

.sidebar-btn {
  margin: 0;
  padding: var(--spacing-sm) var(--spacing-sm);
  background: none;
  color: var(--color-text-primary);
  border: none;
  border-radius: var(--radius-lg);
  font-weight: 500;
  font-size: var(--font-size-sm);
  display: flex;
  align-items: center;
  justify-content: left;
  gap: var(--spacing-sm);
  cursor: pointer;
  /* 过渡对齐 shadcn ghost 按钮手感（transition-colors） */
  transition: background var(--transition-fast), color var(--transition-fast), opacity var(--transition-fast);
  white-space: nowrap;
  overflow: hidden;
  width: 100%;
  box-shadow: none;
}

.sidebar-btn .icon {
  flex-shrink: 0;
  width: var(--sidebar-icon-size);
  height: var(--sidebar-icon-size);
  color: var(--color-text-primary);
  transition: color var(--transition-fast);
}

.sidebar-btn.active {
  background: var(--color-active-bg);
  color: var(--color-brand-accent);
}

.sidebar-btn.active .icon {
  color: var(--color-brand-accent);
}

.sidebar-btn:hover,
.toggle-sidebar-btn:hover {
  /* hover 背景对齐 shadcn ghost 按钮（bg-accent = --color-active-bg） */
  background: var(--color-active-bg);
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

.sidebar.collapsed .btn-text {
  opacity: 0;
  max-width: 0;
  overflow: hidden;
}

.sidebar.collapsed .btn-text {
  transition: var(--sidebar-btn-text-transition-out), max-width 0s ease 0.15s;
}

.sidebar-mode {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.sidebar-mode-enter-active,
.sidebar-mode-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.sidebar-mode-enter-from {
  opacity: 0;
  transform: translateY(4px);
}
.sidebar-mode-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.admin-nav-list {
  flex: 1;
  min-height: 0;
  padding: 0 var(--spacing-sm);
  overflow-y: auto;
  /* padding: var(--spacing-xs) 0; */
}
.admin-nav-overview {
  margin: 0 0 var(--spacing-xs);
  padding-bottom: var(--spacing-sm);
}
.admin-nav-group { padding: var(--spacing-xs) 0; }
.admin-nav-group + .admin-nav-group {
  border-top: 1px solid var(--color-border);
  margin-top: var(--spacing-xs);
  padding-top: var(--spacing-sm);
}
.sidebar.collapsed .admin-nav-group-label {
  opacity: 0;
  max-height: 0;
  margin: 0;
  padding: 0;
  overflow: hidden;
}
.admin-nav-group-label {
  padding: var(--spacing-xs) var(--spacing-sm);
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--color-text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  opacity: 1;
  max-height: 24px;
  transition: opacity var(--transition-fast), max-height var(--transition-fast), padding var(--transition-fast), margin var(--transition-fast);
}
.admin-nav-item.active { background: var(--color-active-bg); color: var(--color-text-primary); }

.sidebar-footer {
  padding: var(--spacing-sm);
  margin-top: auto;
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--spacing-xs);
  /* border-top: 1px solid var(--color-border); */
}
.footer-toggle-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 5px;
  background: none;
  color: var(--color-text-secondary);
  border: none;
  border-radius: var(--radius-lg);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background var(--transition-fast), color var(--transition-fast);
}
.footer-toggle-btn:hover { background: var(--color-hover-overlay-md); color: var(--color-text-primary); }
.sidebar.collapsed .footer-toggle-btn { display: none; }

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
  border-radius: 20px 0 0 20px;
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

.chat-layout--sidebar-overlay {
  padding: 0;
  gap: 0;
}

.chat-layout--sidebar-overlay .sidebar-backdrop {
  background: rgba(var(--color-scrim-rgb), 0.42);
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
