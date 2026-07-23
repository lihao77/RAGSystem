import { createRouter, createWebHistory } from 'vue-router';
import MainLayout from '../layouts/MainLayout.vue';
import { useBootstrapStore } from '../stores/bootstrap.js';
import { useAuthStore } from '../stores/auth.js';

const ChatViewV2 = () => import('../views/ChatViewV2.vue');
const AdminCenter = () => import('../views/AdminCenter.vue');
const AgentMonitor = () => import('../views/AgentMonitor.vue');
const AgentConfig = () => import('../views/AgentConfig.vue');
const TeamBuilder = () => import('../views/TeamBuilder.vue');
const MCPManager = () => import('../views/MCPManager.vue');
const KnowledgeBaseManager = () => import('../views/KnowledgeBaseManager.vue');
const SkillLibrary = () => import('../views/SkillLibrary.vue');
const ModelProviderManager = () => import('../views/ModelProviderManager.vue');
const Bots = () => import('../views/Bots.vue');
const SystemConfig = () => import('../views/SystemConfig.vue');
const WidgetConsole = () => import('../views/WidgetConsole.vue');
const MembersManager = () => import('../views/MembersManager.vue');
const Login = () => import('../views/Login.vue');
const InstallWizard = () => import('../views/InstallWizard.vue');
const PlatformTenants = () => import('../views/PlatformTenants.vue');
const PlatformUsers = () => import('../views/PlatformUsers.vue');
const MemoryManager = () => import('../views/MemoryManager.vue');

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
    meta: shellMeta,
    children: [
      { path: '', component: ChatViewV2, meta: pageMeta('chat', 0, 0) },
      { path: 'chat/:id?', component: ChatViewV2, meta: pageMeta('chat', 0, 0) },
      { path: 'admin', component: AdminCenter, meta: adminPageMeta('admin', 1, 1, 'admin') },
      { path: 'monitor', component: AgentMonitor, meta: adminPageMeta('monitor', 2, 5) },
      { path: 'agent-monitor', redirect: '/monitor' },
      { path: 'team-builder', component: TeamBuilder, meta: adminPageMeta('team-builder', 2, 2) },
      { path: 'agent-config', component: AgentConfig, meta: adminPageMeta('agent-config', 2, 3) },
      { path: 'mcp', component: MCPManager, meta: adminPageMeta('mcp', 3, 4) },
      { path: 'knowledge-base', component: KnowledgeBaseManager, meta: adminPageMeta('knowledge-base', 4, 5) },
      { path: 'skill-library', component: SkillLibrary, meta: adminPageMeta('skill-library', 4, 6) },
      { path: 'model-providers', component: ModelProviderManager, meta: adminPageMeta('model-providers', 5, 2) },
      { path: 'bots', component: Bots, meta: adminPageMeta('bots', 6, 6, 'member') },
      { path: 'memory', component: MemoryManager, meta: adminPageMeta('memory', 6, 7, 'member') },
      { path: 'system-config', component: SystemConfig, meta: adminPageMeta('system-config', 7, 7, 'owner') },
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

router.beforeEach(async (to) => {
  const bootstrapStore = useBootstrapStore();
  const authStore = useAuthStore();

  if (import.meta.env.DEV && ['empty', 'artifact'].includes(String(to.query?.__smoke || ''))) {
    bootstrapStore.$patch({
      profile: { auth: 'local', ui: 'local', deployment: 'local' },
      capabilities: {},
      installed: true,
      loaded: true,
    });
    return true;
  }

  await bootstrapStore.load();

  if (bootstrapStore.needsInstall && to.path !== '/install') {
    return { path: '/install' };
  }
  if (!bootstrapStore.needsInstall && to.path === '/install') {
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
