import { createRouter, createWebHistory } from 'vue-router';
import MainLayout from '../layouts/MainLayout.vue';

const ChatViewV2 = () => import('../views/ChatViewV2.vue');
const AdminCenter = () => import('../views/AdminCenter.vue');
const AgentMonitor = () => import('../views/AgentMonitor.vue');
const AgentConfig = () => import('../views/AgentConfig.vue');
const TeamBuilder = () => import('../views/TeamBuilder.vue');
const MCPManager = () => import('../views/MCPManager.vue');
const VectorLibraryManager = () => import('../views/VectorLibraryManager.vue');
const ModelProviderManager = () => import('../views/ModelProviderManager.vue');
const DaemonManager = () => import('../views/DaemonManager.vue');
const SystemConfig = () => import('../views/SystemConfig.vue');

const shellMeta = {
  depth: 0,
  shellKey: 'main-layout',
};

const pageMeta = (mainView, depth, pageOrder = depth, extra = {}) => ({
  mainView,
  pageKey: mainView,
  depth,
  pageOrder,
  ...extra,
});

const adminPageMeta = (mainView, depth, pageOrder = depth) => pageMeta(mainView, depth, pageOrder, {
  section: 'admin',
});

const routes = [
  {
    path: '/',
    component: MainLayout,
    meta: shellMeta,
    children: [
      { path: '', component: ChatViewV2, meta: pageMeta('chat', 0, 0) },
      { path: 'chat/:id?', component: ChatViewV2, meta: pageMeta('chat', 0, 0) },
      { path: 'admin', component: AdminCenter, meta: adminPageMeta('admin', 1, 1) },
      { path: 'monitor', component: AgentMonitor, meta: adminPageMeta('monitor', 2, 5) },
      { path: 'agent-monitor', redirect: '/monitor' },
      { path: 'team-builder', component: TeamBuilder, meta: adminPageMeta('team-builder', 2, 2) },
      { path: 'agent-config', component: AgentConfig, meta: adminPageMeta('agent-config', 2, 3) },
      { path: 'mcp', component: MCPManager, meta: adminPageMeta('mcp', 3, 4) },
      { path: 'vector-library', component: VectorLibraryManager, meta: adminPageMeta('vector-library', 4, 5) },
      { path: 'model-providers', component: ModelProviderManager, meta: adminPageMeta('model-providers', 5, 2) },
      { path: 'daemon', component: DaemonManager, meta: adminPageMeta('daemon', 6, 6) },
      { path: 'system-config', component: SystemConfig, meta: adminPageMeta('system-config', 7, 7) },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
