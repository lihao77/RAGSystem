<template>
  <div class="chat-layout" :class="{ 'chat-layout--sidebar-overlay': isMobile }">
    <div class="sidebar-backdrop" :class="{ active: mobileOpen }" @click="closeMobileSidebar"></div>

    <aside class="sidebar" :class="{ collapsed: sidebarCollapsed, 'mobile-open': mobileOpen }">
      <!-- 顶栏只保留拖拽区与移动端 logo：桌面端的开关/新聊天常驻窗口左上角固定浮钮，
           不随侧栏收起移动位置。 -->
      <div class="sidebar-top-bar">
        <div class="sidebar-top-bar__left">
          <button
            type="button"
            class="sidebar-logo-wrapper"
            :aria-label="'打开菜单'"
            title="打开菜单"
            @click="toggleSidebar"
          >
            <span class="sidebar-logo-box">
              <IconLogo :size="28" class="sidebar-logo-icon" simple />
            </span>
          </button>
        </div>
      </div>

      <Transition name="sidebar-mode" mode="out-in">
        <div v-if="isChatRoute" key="chat" class="sidebar-mode" :class="{ 'is-stowed': isBodyStowed }">
      <div v-show="!isFilesView && !sidebarCollapsed" class="sidebar-header">
        <button class="sidebar-btn" :class="{ active: isPageActive('chat') && !activeSessionId }" @click="startNewChat">
          <IconNewConversation class="icon" />
          <span class="btn-text">新聊天</span>
        </button>
      </div>

      <!-- 会话列表 ↔ 文件导航：互斥切换带过渡（v-if 分支，数据都在 pinia，重挂载无成本）。
           折叠时整个主体随 is-stowed 左滑退出，不再保留图标轨内容。 -->
      <Transition name="sidebar-mode" mode="out-in">
        <div v-if="isFilesView" key="workspace-files" class="sidebar-mode-body">
          <WorkspaceFileNav
            :workspace-id="filesWorkspaceId"
            @update:workspace-id="(id) => { filesWorkspaceId = id }"
            @exit="exitWorkspaceFiles"
          />
        </div>
        <div v-else key="sessions" class="sidebar-mode-body">
          <SessionList
            :active-session-id="activeSessionId"
            :chat-sdk-client="chatSdkClient"
            :view-mode="browserView"
            @update:view-mode="handleBrowserViewChange"
            @select="selectSession"
            @delete="confirmDeleteSession"
            @select-workspace="handleWorkspaceChange"
            @rename-workspace="openRenameWorkspace"
            @remove-workspace="confirmRemoveWorkspace"
            @purge-workspace="confirmPurgeWorkspace"
            @browse-workspace="enterWorkspaceFiles"
          />
        </div>
      </Transition>
      <WorkspaceRenameDialog
        v-model="renameWorkspaceOpen"
        :chat-sdk-client="chatSdkClient"
        :workspace="renameWorkspaceTarget"
        @renamed="handleWorkspaceRenamed"
      />
      </div>

      <div v-else key="admin" class="sidebar-mode" :class="{ 'is-stowed': isBodyStowed }">
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
        <SceneSwitcher />
        <UserMenu />
        <button
          class="footer-toggle-btn"
          :title="isChatRoute ? '管理中心' : '返回聊天'"
          :aria-label="isChatRoute ? '管理中心' : '返回聊天'"
          @click="navigateTo(isChatRoute ? managementEntryPath : '/')"
        >
          <component :is="isChatRoute ? sidebarAdminNavItem.icon : IconChevronLeft" :size="20" />
        </button>
      </div>
    </aside>

    <!-- 左上角固定浮钮：折叠/展开开关全程钉在同一像素位置（侧栏收起时也原地不动），
         hover 时 logo 与方向箭头原位淡切；文件视图/折叠态时旁边出现新聊天。 -->
    <div class="sidebar-toggle-float" :class="{ 'is-collapsed': sidebarCollapsed }">
      <button
        type="button"
        class="sbf-toggle"
        :title="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
        :aria-label="sidebarCollapsed ? '展开侧栏' : '折叠侧栏'"
        @click="toggleSidebar"
      >
        <span class="sbf-toggle__box">
            <IconLogo :size="28" class="sidebar-logo-icon" simple />
            <PanelLeftClose :size="16" class="sbf-toggle__alt sbf-toggle__alt--collapse" aria-hidden="true" />
            <PanelLeftOpen :size="16" class="sbf-toggle__alt sbf-toggle__alt--expand" aria-hidden="true" />
          </span>
      </button>
      <Transition name="sidebar-mode">
        <button
          v-if="isFilesView || sidebarCollapsed"
          class="sbf-action"
          title="新聊天"
          aria-label="新聊天"
          @click="startNewChat"
        >
          <IconNewConversation :size="16" />
        </button>
      </Transition>
    </div>

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
import { PanelLeftClose, PanelLeftOpen } from 'lucide-vue-next';
import { IconLogo, IconChevronLeft, IconNewConversation } from '../components/icons';
import { Button } from '../components/ui/button';
import UserMenu from '../components/UserMenu.vue';
import SceneSwitcher from '../components/SceneSwitcher.vue';
import SessionList from '../components/session-list/SessionList.vue';
import WorkspaceFileNav from '../components/workspace/WorkspaceFileNav.vue';
import WorkspaceRenameDialog from '../components/workspace/WorkspaceRenameDialog.vue';
import { SESSION_BROWSER_VIEWS, UNASSIGNED_WORKSPACE_ID, useWorkspaceStore } from '../stores/workspace.js';
import { sidebarAdminNavItem, filterManagementNavItems, adminNavGroups, IconPluginView } from '../navigation/adminNavigation';
import { usePluginStore } from '../stores/plugins.js';
import { ensurePluginViewRoutes } from '../router/index.js';
import CommandPalette from '../components/CommandPalette.vue';
import { useCommandPalette } from '../composables/useCommandPalette.js';
import HotkeysHelp from '../components/HotkeysHelp.vue';
import { useGlobalHotkeys } from '../composables/useGlobalHotkeys.js';
import AdminLayout from './AdminLayout.vue';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '../components/ui/dialog';
import { Input } from '../components/ui/input';
import { getMCPServerPrompt } from '../api/mcpService';
import { useMcpStore } from '../stores/mcp.js';
import { SIDEBAR_OVERLAY_QUERY } from '../utils/breakpoints.js';

const router = useRouter();
const route = useRoute();
const toast = useToast();
const { confirm } = useConfirm();
const sessionListStore = useSessionListStore();
const chatSdkClient = getFrontendChatSdk();
sessionListStore.setChatSdkClient(chatSdkClient);
const workspaceStore = useWorkspaceStore();
workspaceStore.setClient(chatSdkClient);
provide('chatSdkClient', chatSdkClient);
const bootstrapStore = useBootstrapStore();
const authStore = useAuthStore();
const { isPlatformAdmin, hasTenantRole } = usePermission();
const { items: history } = storeToRefs(sessionListStore);
const { browserView } = storeToRefs(workspaceStore);
const sidebarCollapsed = ref(localStorage.getItem('sidebarCollapsed') === 'true');
const mobileOpen = ref(false);
const isMobile = ref(false);
const lastChatSessionId = ref(null);

const isChatRoute = computed(() => (route.meta?.mainView || 'chat') === 'chat');
const pageShell = computed(() => (isChatRoute.value ? 'div' : AdminLayout));
const isPageActive = (mainView) => (route.meta?.mainView || 'chat') === mainView;
const pluginsStore = usePluginStore();
// 插件 management 视图的导航项（来自 tenant 清单的 ui.views；非 exposePublic 插件只在这里可见）
const pluginManagementNavItems = computed(() => {
  const items = [];
  for (const plugin of pluginsStore.installed) {
    for (const view of plugin.ui?.views ?? []) {
      if (view?.placement !== 'management' || !view?.route || !view?.entry) continue;
      const mainView = `plugin:${plugin.id}:${view.entry}`;
      items.push({
        key: mainView,
        mainView,
        path: view.route,
        label: view.title || view.entry,
        title: view.title || view.entry,
        description: `插件 ${plugin.id} 提供的管理页面。`,
        group: 'operations',
        requireTenantRole: 'admin',
        icon: IconPluginView,
      });
    }
  }
  return items;
});
if (authStore.isAuthenticated && hasTenantRole('admin')) {
  // tenant 完整清单：management 视图的路由补注册 + 导航项
  pluginsStore.loadInstalled()
    .then((plugins) => ensurePluginViewRoutes(plugins))
    .catch(() => {});
}
const visibleManagementNavItems = computed(() => filterManagementNavItems(bootstrapStore.capabilities, {
  isAuthenticated: authStore.isAuthenticated,
  authMode: bootstrapStore.profile.auth,
  isLocal: bootstrapStore.profile.ui === 'local' || bootstrapStore.profile.deployment === 'local',
  isPlatformAdmin: isPlatformAdmin.value,
  hasTenantRole,
}, pluginManagementNavItems.value));
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
// 侧栏在所有路由下于同一断点切抽屉/固定，避免切页时行为不一致。
// 查询串与样式表的三处媒体查询同值（见 utils/breakpoints.js）；用 matchMedia 而非
// window.innerWidth，后者含滚动条宽度，会在断点附近与 CSS 的判定基准对不上。
const sidebarOverlayQuery = window.matchMedia(SIDEBAR_OVERLAY_QUERY);

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
  isMobile.value = sidebarOverlayQuery.matches;
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

// 会话顶栏"展开侧栏"按钮的落点：移动端开抽屉，桌面端展开并持久化
const expandSidebar = () => {
  if (isMobile.value) {
    openMobileSidebar();
    return;
  }
  sidebarCollapsed.value = false;
  localStorage.setItem('sidebarCollapsed', 'false');
};

// 折叠后的展开入口只挂在聊天页会话顶栏；管理页的导航就是侧栏本身，
// 带着折叠态进管理页会迷路——进入时自动展开兜底。
watch(isChatRoute, (chat) => {
  if (!chat && sidebarCollapsed.value && !isMobile.value) {
    expandSidebar();
  }
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

// 供会话顶栏/移动端抽屉使用（开关浮钮在 MainLayout 自身模板里，直接调本地函数）
provide('shellSidebarControl', {
  openMobileSidebar,
  closeMobileSidebar,
});

const handleWorkspaceChange = async (workspace) => {
  workspaceStore.select(workspace?.workspace_id || UNASSIGNED_WORKSPACE_ID);
  if (activeSessionId.value) await startNewChat();
};

const handleBrowserViewChange = async (view) => {
  workspaceStore.selectView(view);
  await sessionListStore.setFilters({ originType: null, originId: null, workspaceId: null });
};

// ── 项目文件导航 ──
// 入口在 SessionList 项目分组头的「浏览文件」按钮：带着目标项目切进文件视图。
const isFilesView = computed(() => browserView.value === SESSION_BROWSER_VIEWS.FILES);
// 折叠收纳：桌面端折叠时主体（列表/导航/管理导航）整体左滑退出；移动端抽屉不受折叠态影响
const isBodyStowed = computed(() => sidebarCollapsed.value && !isMobile.value);
const filesWorkspaceId = ref('');
const enterWorkspaceFiles = (workspace) => {
  if (workspace?.workspace_id) filesWorkspaceId.value = workspace.workspace_id;
  workspaceStore.selectView(SESSION_BROWSER_VIEWS.FILES);
};
const exitWorkspaceFiles = () => {
  workspaceStore.selectView(SESSION_BROWSER_VIEWS.PROJECT);
};

const confirmRemoveWorkspace = async (workspace) => {
  if (!workspace?.workspace_id) return;
  const accepted = await confirm({
    title: '移除项目',
    message: `确定要移除项目“${workspace.display_name}”吗？已有会话不会删除。`,
    confirmText: '移除',
    danger: true,
  });
  if (!accepted) return;
  try {
    await workspaceStore.remove(workspace.workspace_id);
    void sessionListStore.loadFacets().catch(() => undefined);
    // 移除是软删：会话保持与项目的绑定并随之隐藏，重新添加同一路径即恢复；刷新项目分组
    if (workspaceStore.browserView === SESSION_BROWSER_VIEWS.PROJECT) {
      void sessionListStore.loadWorkspacePreview().catch(() => undefined);
    }
  } catch (error) {
    showToast(error.message || '项目移除失败');
  }
};

const confirmPurgeWorkspace = async (workspace) => {
  if (!workspace?.workspace_id) return;
  const count = Number(workspace.session_count ?? 0);
  const scopeText = count > 0 ? `及其下 ${count} 个会话` : '及其下全部会话';
  const accepted = await confirm({
    title: '移除项目并删除会话',
    message: `确定要移除项目“${workspace.display_name}”${scopeText}吗？会话删除后不可恢复。`,
    confirmText: '移除并删除',
    danger: true,
  });
  if (!accepted) return;
  try {
    const result = await workspaceStore.remove(workspace.workspace_id, { deleteSessions: true });
    const deletedIds = result?.deleted_session_ids ?? [];
    deletedIds.forEach((id) => sessionListStore.remove(id));
    void sessionListStore.loadFacets().catch(() => undefined);
    // 项目分组视图整组消失，刷新预览与游标
    if (workspaceStore.browserView === SESSION_BROWSER_VIEWS.PROJECT) {
      void sessionListStore.loadWorkspacePreview().catch(() => undefined);
    }
    if (activeSessionId.value && deletedIds.includes(activeSessionId.value)) {
      await startNewChat();
    }
    const failedCount = result?.failed?.length ?? 0;
    if (failedCount > 0) {
      showToast(`已移除项目，删除 ${deletedIds.length} 个会话，${failedCount} 个会话无权限删除`);
    } else {
      showToast(`已移除项目并删除 ${deletedIds.length} 个会话`, 'success');
    }
  } catch (error) {
    showToast(error.message || '项目移除失败');
  }
};

const renameWorkspaceOpen = ref(false);
const renameWorkspaceTarget = ref(null);
const openRenameWorkspace = (workspace) => {
  if (!workspace?.workspace_id) return;
  renameWorkspaceTarget.value = workspace;
  renameWorkspaceOpen.value = true;
};
const handleWorkspaceRenamed = () => {
  void sessionListStore.loadFacets().catch(() => undefined);
  // 会话条目与筛选面板里的项目名快照一并刷新
  if (workspaceStore.browserView === SESSION_BROWSER_VIEWS.PROJECT) {
    void sessionListStore.loadWorkspacePreview().catch(() => undefined);
  }
};

const selectSession = async (item) => {
  if (!item?.session_id) return;
  if (workspaceStore.browserView === SESSION_BROWSER_VIEWS.PROJECT) {
    workspaceStore.select(item.workspace?.workspace_id || UNASSIGNED_WORKSPACE_ID);
  }
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
  workspaceStore.load().then(() => {
    void sessionListStore.setFilters({ originType: null, originId: null, workspaceId: null });
  }).catch(() => undefined);
  installCommandPaletteHotkey();
  installGlobalHotkeys();
});

onUnmounted(() => {
  window.removeEventListener('resize', checkMobile);
  document.body.style.overflow = '';
  sessionListStore.setChatSdkClient(null);
  workspaceStore.clear();
  destroyFrontendChatSdk();
});
</script>

<style scoped>
.mcp-prompt-args { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.mcp-prompt-args .field { display: flex; flex-direction: column; gap: 4px; font-size: var(--font-size-sm); }
.mcp-prompt-args .field span { color: var(--color-text-secondary); }
.mcp-prompt-args .field em { color: var(--color-error); font-style: normal; margin-left: 2px; }
/* 三卡片外壳：侧栏不铺卡片底色（与窗口背景同色），对话卡与右侧运行工作台各是一张卡。
   外壳内边距与卡间缝同宽（--shell-gap，取间距标尺最小档），缝里放工作台的可拖拽分隔条；
   设置页/登录页复用同一内边距与卡片口径。 */
.chat-layout {
  --sidebar-btn-text-transition-in: opacity var(--duration-base) ease 0.05s;
  --sidebar-btn-text-transition-out: opacity var(--duration-fast) ease;
  --shell-gap: var(--spacing-xs);
  /* 左上角固定浮轨宽度：15 左距 + 28 开关 + 2 缝 + 28 新聊天（折叠态两个按钮都在）。
     折叠态会话顶栏按它让位，改浮轨尺寸只需改这里。 */
  --sidebar-rail-width: 73px;
  /* 浮轨相对对话卡左缘的占位：扣掉对话卡自身的内缩（外壳 gap + 卡片边框 1px），
     顶栏让位 = 本变量 + 顶栏常规内距。 */
  --sidebar-rail-reserve: calc(var(--sidebar-rail-width) - var(--shell-gap, 4px) - 1px);
  position: relative;
  display: flex;
  height: 100vh;
  height: 100dvh;
  width: 100%;
  max-width: 100%;
  background-color: var(--surface-sidebar);
  overflow: hidden;
  padding: var(--shell-gap);
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
  /* 主体左滑退出时内容需在侧栏内裁剪（下拉菜单均经 portal 渲染，不受影响） */
  overflow: hidden;
  /* 与对话卡之间留一条同宽的缝（侧栏不铺卡片底色，缝里是外壳底色）。
     窄屏抽屉形态下侧栏是 fixed，外边距不参与定位，无需另写覆盖。 */
  margin-right: var(--shell-gap, 0);
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

/* 折叠 = 完全退出布局：宽度归零、缝隙一并收回，对话区占满全宽；
   左缘的 logo/新聊天/底部入口由 .sidebar-floating-rail 悬浮轨承载。 */
.sidebar.collapsed {
  width: 0;
  margin-right: 0;
}

/* Electron 桌面端隐藏原生标题栏后，logo 行兼任标题栏：整行可拖拽/双击最大化，
   交互子元素（logo、折叠按钮）排除；浏览器中 app-region 无效，不影响 Web 端。
   高度与顶栏行统一 44px；右上角窗口控件为前端自绘（WindowControls.vue），与本行内容同线。 */
.sidebar-top-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: 44px;
  /* 左距让 28px logo 框中心对齐列表图标中心线（8px 容器 + 8px 按钮内边距 + 9px 半图标 = 25px） */
  padding: 6px 8px 6px 11px;
  transition: all var(--transition-normal);
  -webkit-app-region: drag;
  app-region: drag;
}

.sidebar-top-bar :is(button, [role='button'], .sidebar-logo-wrapper) {
  -webkit-app-region: no-drag;
  app-region: no-drag;
}

/* 顶栏左组：logo + 文件视图下的新聊天快捷入口 */
.sidebar-top-bar__left {
  display: flex;
  flex: 1;
  min-width: 0;
  align-items: center;
  gap: 2px;
}

.topbar-new-chat-btn {
  flex-shrink: 0;
}

/* 会话列表/文件导航互斥分支的宿主：占满侧栏剩余高度 */
.sidebar-mode-body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.sidebar-logo-wrapper {
  position: relative;
  /* 与桌面浮轨 logo 开关同档（28 框装 28 logo） */
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: left;
  border: none;
  background: none;
  padding: 0;
}

.sidebar-logo-box {
  position: relative;
  display: flex;
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  align-items: center;
  justify-content: center;
}

.sidebar-logo-icon {
  flex-shrink: 0;
  transition: opacity var(--transition-fast);
}

/* ── 左上角固定浮钮：折叠/展开开关 ──
   绝对定位在窗口左上角，侧栏收起到 0 宽也不移动；
   hover 时 logo 淡出、方向箭头（按当前态取收起/展开方向）原位淡入。 */
.sidebar-toggle-float {
  position: absolute;
  top: var(--shell-gap, 4px);
  left: 0;
  z-index: calc(var(--z-sidebar) + 1);
  display: flex;
  /* 宽度显式取自变量：折叠态顶栏的让位宽度以它为准 */
  width: var(--sidebar-rail-width);
  height: 44px;
  align-items: center;
  gap: 2px;
  /* 图标中心线对齐列表图标（外壳 4px 边距 + 侧栏 8px 容器 + 8px 按钮内边距 + 18px 图标半宽 = 29px；
     28px 开关框居中 → 左距 29 - 14 = 15px） */
  padding-left: 15px;
  /* 容器本身不拦截事件：不打断下方顶栏的 Electron 拖拽，仅按钮可点 */
  pointer-events: none;
}

.sidebar-toggle-float > * {
  pointer-events: auto;
}

.sbf-toggle {
  position: relative;
  display: flex;
  /* 与顶栏按钮同档（rw-collapse 28）；28px logo 在 28 框内正好贴合（logo 自带约 10% 内边距） */
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-lg);
  background: none;
  padding: 0;
  cursor: pointer;
}

.sbf-toggle:hover {
  background: var(--color-hover-overlay-md);
}

.sbf-toggle__box {
  position: relative;
  display: flex;
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  align-items: center;
  justify-content: center;
}

.sbf-toggle__alt {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  color: var(--color-text-secondary);
  pointer-events: none;
  transition: opacity var(--transition-fast);
}

.sbf-toggle:hover .sidebar-logo-icon {
  opacity: 0;
}

.sidebar-toggle-float:not(.is-collapsed) .sbf-toggle:hover .sbf-toggle__alt--collapse {
  opacity: 1;
}

.sidebar-toggle-float.is-collapsed .sbf-toggle:hover .sbf-toggle__alt--expand {
  opacity: 1;
}

.sbf-action {
  display: flex;
  /* 与顶栏按钮同档（rw-collapse 28） */
  width: var(--control-height-sm);
  height: var(--control-height-sm);
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: var(--radius-lg);
  background: none;
  color: var(--color-text-secondary);
  padding: 0;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.sbf-action:hover {
  background: var(--color-hover-overlay-md);
  color: var(--color-text-primary);
}

/* 移动端：开关走抽屉（会话顶栏汉堡），浮钮不出现 */
.chat-layout--sidebar-overlay .sidebar-toggle-float {
  display: none;
}

/* 桌面端侧栏顶栏只保留拖拽区；logo 仅移动端抽屉里显示 */
.sidebar-top-bar__left {
  display: none;
}

.chat-layout--sidebar-overlay .sidebar-top-bar__left {
  display: flex;
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
  margin-bottom: 8px;
  padding: 0 var(--spacing-sm);
}
.sidebar.collapsed .sidebar-header { margin-bottom: 0; }

.sidebar-btn {
  margin: 0;
  min-height: 34px;
  padding: 6px 8px;
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
  transition: transform var(--transition-normal), opacity var(--transition-normal), visibility 0s;
}

/* 折叠收纳：主体整体左滑退出（logo/新聊天留在顶栏、底部图标照旧）。
   visibility 延迟到滑动结束后再隐藏，保证动画可见且收起后不占焦点。 */
.sidebar-mode.is-stowed {
  transform: translateX(-100%);
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transition: transform var(--transition-normal), opacity var(--transition-normal), visibility 0s linear var(--transition-normal);
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
.admin-nav-group { 
  padding: var(--spacing-xs) 0;
    gap: 1px;
    display: flex;
    flex-direction: column;
 }
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
  /* 与同行的场景切换/账户触发器（control-compact）同高 */
  width: var(--control-height-compact);
  height: var(--control-height-compact);
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

/* 对话路由：这里只是承载两张卡的透明容器——对话卡与运行工作台卡自己铺底色、自己带圆角
   （见 chat-view.css 的 .chat-conversation-column 与 RunWorkbench.vue）。 */
.layout-main-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: transparent;
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

/* 管理页：整块就是那张卡（与对话卡同一口径：圆角 + 细边框 + 表面色）。 */
.layout-main-host--page {
  overflow: hidden;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-2xl);
  background: var(--surface-shell);
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
