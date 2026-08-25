import { createRouter, createWebHistory } from 'vue-router';
import MainLayout from '../layouts/MainLayout.vue';
import PluginViewHost from '../components/plugin/PluginViewHost.vue';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { useAuthStore } from '../stores/auth.js';
import { usePluginStore } from '../stores/plugins.js';

const ChatViewV2 = () => import('../views/ChatViewV2.vue');
const AdminCenter = () => import('../views/AdminCenter.vue');
const AgentMonitor = () => import('../views/AgentMonitor.vue');
const AgentStudio = () => import('../views/AgentStudio.vue');
const MCPManager = () => import('../views/MCPManager.vue');
const KnowledgeBaseManager = () => import('../views/KnowledgeBaseManager.vue');
const SkillLibrary = () => import('../views/SkillLibrary.vue');
const ModelProviderManager = () => import('../views/ModelProviderManager.vue');
const Bots = () => import('../views/Bots.vue');
const SystemConfig = () => import('../views/SystemConfig.vue');
const PluginSettings = () => import('../views/PluginSettings.vue');
const WidgetConsole = () => import('../views/WidgetConsole.vue');
const MembersManager = () => import('../views/MembersManager.vue');
const Login = () => import('../views/Login.vue');
const InstallWizard = () => import('../views/InstallWizard.vue');
const PlatformTenants = () => import('../views/PlatformTenants.vue');
const PlatformUsers = () => import('../views/PlatformUsers.vue');
const MemoryManager = () => import('../views/MemoryManager.vue');
const SchedulerTasks = () => import('../views/SchedulerTasks.vue');

const shellMeta = {
  depth: 0,
  shellKey: 'main-layout',
  requiresAuth: true,
};

const pageMeta = (mainView, depth, pageOrder = depth, extra = {}) => ({
  mainView,
  pageKey: mainView,
  depth,
  pageOrder,
  ...extra,
});

const adminPageMeta = (mainView, depth, pageOrder = depth, requireTenantRole = 'admin') => pageMeta(mainView, depth, pageOrder, {
  section: 'admin',
  requireTenantRole,
});

const routes = [
  { path: '/login', component: Login, meta: { public: true, depth: 0, shellKey: 'auth-layout' } },
  { path: '/install', component: InstallWizard, meta: { public: true, depth: 0, shellKey: 'auth-layout' } },
  {
    path: '/',
    component: MainLayout,
    name: 'shell',
    meta: shellMeta,
    children: [
      { path: '', component: ChatViewV2, meta: pageMeta('chat', 0, 0) },
      { path: 'chat/:id?', component: ChatViewV2, meta: pageMeta('chat', 0, 0) },
      { path: 'admin', component: AdminCenter, meta: adminPageMeta('admin', 1, 1, 'admin') },
      { path: 'monitor', component: AgentMonitor, meta: adminPageMeta('monitor', 2, 5) },
      { path: 'agent-monitor', redirect: '/monitor' },
      { path: 'agent-studio', component: AgentStudio, meta: adminPageMeta('agent-studio', 2, 2) },
      { path: 'team-builder', redirect: '/agent-studio' },
      { path: 'agent-config', redirect: '/agent-studio' },
      { path: 'mcp', component: MCPManager, meta: adminPageMeta('mcp', 3, 4) },
      { path: 'knowledge-base', component: KnowledgeBaseManager, meta: adminPageMeta('knowledge-base', 4, 5) },
      { path: 'skill-library', component: SkillLibrary, meta: adminPageMeta('skill-library', 4, 6) },
      { path: 'model-providers', component: ModelProviderManager, meta: adminPageMeta('model-providers', 5, 2) },
      { path: 'bots', component: Bots, meta: adminPageMeta('bots', 6, 6, 'member') },
      { path: 'scheduler', component: SchedulerTasks, meta: adminPageMeta('scheduler', 6, 7, 'member') },
      { path: 'memory', component: MemoryManager, meta: adminPageMeta('memory', 6, 7, 'member') },
      { path: 'system-config', component: SystemConfig, meta: adminPageMeta('system-config', 7, 7, 'owner') },
      { path: 'plugins-settings', component: PluginSettings, meta: adminPageMeta('plugins-settings', 7, 8, 'owner') },
      { path: 'widget-credentials', component: WidgetConsole, meta: adminPageMeta('widget-credentials', 8, 8, 'owner') },
      { path: 'members', component: MembersManager, meta: adminPageMeta('members', 8, 9, 'admin') },
      { path: 'platform', redirect: '/platform/tenants', meta: pageMeta('platform', 9, 10, { section: 'platform', requiresPlatformAdmin: true }) },
      { path: 'platform/tenants', component: PlatformTenants, meta: pageMeta('platform-tenants', 9, 10, { section: 'platform', requiresPlatformAdmin: true }) },
      { path: 'platform/users', component: PlatformUsers, meta: pageMeta('platform-users', 9, 11, { section: 'platform', requiresPlatformAdmin: true }) },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

// ---- 插件 view 路由动态注册（清单来自 GET /api/plugins/ui-manifests） ----
let pluginRoutesRegistered = false;
// management 视图依赖 tenant 完整清单（认证后可得）；直开 URL 时守卫补注册并重试
let installedPluginRoutesRegistered = false;

function registerPluginRoutes(manifests) {
  for (const plugin of manifests ?? []) {
    for (const view of plugin.views ?? []) {
      if (!view?.route || !view?.entry) continue;
      const bundleUrl = plugin.bundleUrl || view.bundleUrl;
      if (!bundleUrl) continue;
      const routeName = `plugin-view:${plugin.id}:${view.entry}`;
      if (router.hasRoute(routeName)) continue;
      const props = { pluginId: plugin.id, entry: view.entry, bundleUrl, view };
      if (view.placement === 'management') {
        // 管理中心页：挂在 MainLayout 内，与其他管理页同等鉴权（admin 起）
        router.addRoute('shell', {
          path: view.route,
          name: routeName,
          component: PluginViewHost,
          props,
          meta: pageMeta(`plugin:${plugin.id}:${view.entry}`, 10, 20, { section: 'admin', requireTenantRole: 'admin' }),
        });
      } else {
        // 独立页（如桌面宠物窗直开）：public 标记免登录
        router.addRoute({
          path: view.route,
          name: routeName,
          component: PluginViewHost,
          props,
          meta: view.public
            ? { public: true, depth: 0, shellKey: `plugin:${plugin.id}` }
            : pageMeta(`plugin:${plugin.id}:${view.entry}`, 10, 20, { section: 'admin', requireTenantRole: 'admin' }),
        });
      }
    }
  }
}

/**
 * 从 tenant 完整清单补注册插件 view 路由（非 exposePublic 插件的 management 视图
 * 不在公开清单里；MainLayout 加载 installed 后调用，幂等）。
 */
export function ensurePluginViewRoutes(plugins) {
  registerPluginRoutes((plugins ?? []).map((plugin) => ({
    id: plugin.id,
    bundleUrl: plugin.ui?.bundleUrl,
    views: plugin.ui?.views ?? [],
  })));
}

router.beforeEach(async (to) => {
  const bootstrapStore = useBootstrapStore();
  const authStore = useAuthStore();

  if (import.meta.env.DEV && ['empty', 'artifact', 'pending-image', 'pending-image-newchat'].includes(String(to.query?.__smoke || ''))) {
    bootstrapStore.$patch({
      profile: { auth: 'local', ui: 'local', deployment: 'local' },
      capabilities: {},
      installed: true,
      loaded: true,
    });
    return true;
  }

  await bootstrapStore.load();

  // 插件 view 路由注册（认证前：宠物独立窗等公开页直开依赖公开清单）。
  // 首次导航可能在注册前已被通配路由重定向（/pet → /），注册后按地址栏原始路径重试一次。
  if (!pluginRoutesRegistered) {
    pluginRoutesRegistered = true;
    const pluginsStore = usePluginStore();
    registerPluginRoutes(await pluginsStore.loadUiManifests());
    if (typeof window !== 'undefined') {
      const intended = window.location.pathname + window.location.search;
      if (intended !== '/' && intended !== to.fullPath) {
        const retry = router.resolve(intended);
        if (retry.matched.length > 0 && retry.name?.startsWith('plugin-view:')) return retry;
      }
    }
  }

  // /pet 是装饰性桌面宠物页：安装完成前也要保持原路由（否则宠物窗口会被
  // 重定向到 /install 并卡住；宠物资产 /api/pet 本身是 public 的，不依赖安装状态）
  // 本地形态免安装（后端启动即固化 installed），任何情况下都不进入安装向导
  const isLocalDeployment = bootstrapStore.profile.deployment === 'local';
  if (bootstrapStore.needsInstall && !isLocalDeployment && to.path !== '/install' && to.path !== '/pet') {
    return { path: '/install' };
  }
  if (to.path === '/install' && (!bootstrapStore.needsInstall || isLocalDeployment)) {
    return { path: bootstrapStore.requiresAuth && !authStore.isAuthenticated ? '/login' : '/' };
  }
  if (!bootstrapStore.requiresAuth && authStore.isAuthenticated) {
    authStore.clear();
  }
  if (!bootstrapStore.requiresAuth) {
    authStore.setPlatformRoleHint(bootstrapStore.profile.platformRole || '');
  } else if (authStore.isAuthenticated && !authStore.identityLoaded) {
    try {
      await authStore.refreshIdentity();
    } catch {
      return { path: '/login', query: { redirect: to.fullPath } };
    }
  }

  // management 位置的插件视图不在公开清单里（需登录态取 tenant 清单）：
  // 直开 URL 会被通配路由先吃掉，这里补注册后按地址栏原始路径重试一次。
  // 本地形态免登录（requiresAuth=false）即可尝试；SaaS 未登录跳过（后续登录后 MainLayout 兜底）。
  if (!installedPluginRoutesRegistered && (authStore.isAuthenticated || !bootstrapStore.requiresAuth)) {
    installedPluginRoutesRegistered = true;
    try {
      ensurePluginViewRoutes(await usePluginStore().loadInstalled());
    } catch {
      // 清单不可达：management 视图本次不可用，不打断导航
    }
    if (typeof window !== 'undefined') {
      const intended = window.location.pathname + window.location.search;
      if (intended !== '/' && intended !== to.fullPath) {
        const retry = router.resolve(intended);
        if (retry.matched.length > 0 && retry.name?.startsWith('plugin-view:')) return retry;
      }
    }
  }
  if (to.path === '/login' && (!bootstrapStore.requiresAuth || authStore.isAuthenticated)) {
    return { path: '/' };
  }
  if (to.meta.public) return true;
  if (bootstrapStore.requiresAuth && !authStore.isAuthenticated && to.path !== '/login') {
    return { path: '/login', query: { redirect: to.fullPath } };
  }
  if (to.meta.requiresPlatformAdmin && !authStore.isPlatformAdmin) {
    return { path: '/' };
  }
  const isLocalMode = bootstrapStore.profile.ui === 'local' || bootstrapStore.profile.deployment === 'local';
  if (isLocalMode && (to.meta.requiresPlatformAdmin || to.path === '/members')) {
    return { path: '/' };
  }
  if (to.meta.requireTenantRole && !authStore.hasTenantRole(to.meta.requireTenantRole)) {
    return { path: '/' };
  }
  return true;
});

export default router;
