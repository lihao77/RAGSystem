import { createRouter, createWebHistory } from 'vue-router';
import MainLayout from '../layouts/MainLayout.vue';

const ChatViewV2 = () => import('../views/ChatViewV2.vue');
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

const pageMeta = (mainView, depth, pageOrder = depth) => ({
  mainView,
  pageKey: mainView,
  depth,
  pageOrder,
});

const routes = [
  {
    path: '/',
    component: MainLayout,
    meta: shellMeta,
    children: [
      { path: '', component: ChatViewV2, meta: pageMeta('chat', 0, 0) },
      { path: 'chat/:id?', component: ChatViewV2, meta: pageMeta('chat', 0, 0) },
      { path: 'monitor', component: AgentMonitor, meta: pageMeta('monitor', 1, 5) },
      { path: 'agent-monitor', redirect: '/monitor' },
      { path: 'team-builder', component: TeamBuilder, meta: pageMeta('team-builder', 2, 1) },
      { path: 'agent-config', component: AgentConfig, meta: pageMeta('agent-config', 2, 2) },
      { path: 'mcp', component: MCPManager, meta: pageMeta('mcp', 3, 3) },
      { path: 'vector-library', component: VectorLibraryManager, meta: pageMeta('vector-library', 4, 4) },
      { path: 'model-providers', component: ModelProviderManager, meta: pageMeta('model-providers', 5, 1) },
      { path: 'daemon', component: DaemonManager, meta: pageMeta('daemon', 6, 6) },
      { path: 'system-config', component: SystemConfig, meta: pageMeta('system-config', 7, 7) },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
