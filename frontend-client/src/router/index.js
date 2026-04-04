import { createRouter, createWebHistory } from 'vue-router';
import MainLayout from '../layouts/MainLayout.vue';
import ChatViewV2 from '../views/ChatViewV2.vue';
import AgentMonitor from '../views/AgentMonitor.vue';
import AgentConfig from '../views/AgentConfig.vue';
import MCPManager from '../views/MCPManager.vue';
import VectorLibraryManager from '../views/VectorLibraryManager.vue';
import ModelProviderManager from '../views/ModelProviderManager.vue';

const shellMeta = {
  depth: 0,
  shellKey: 'main-layout',
};

const routes = [
  {
    path: '/',
    component: MainLayout,
    meta: shellMeta,
    children: [
      { path: '', component: ChatViewV2, meta: { mainView: 'chat' } },
      { path: 'chat/:id?', component: ChatViewV2, meta: { mainView: 'chat' } },
      { path: 'monitor', component: AgentMonitor, meta: { mainView: 'monitor' } },
      { path: 'agent-monitor', redirect: '/monitor' },
      { path: 'agent-config', component: AgentConfig, meta: { mainView: 'agent-config' } },
      { path: 'mcp', component: MCPManager, meta: { mainView: 'mcp' } },
      { path: 'vector-library', component: VectorLibraryManager, meta: { mainView: 'vector-library' } },
      { path: 'model-providers', component: ModelProviderManager, meta: { mainView: 'model-providers' } },
    ],
  },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
