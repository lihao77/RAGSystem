import { createRouter, createWebHistory } from 'vue-router';
import ChatViewV2 from '../views/ChatViewV2.vue';
import AgentMonitor from '../views/AgentMonitor.vue';
import AgentConfig from '../views/AgentConfig.vue';
import MCPManager from '../views/MCPManager.vue';
import VectorLibraryManager from '../views/VectorLibraryManager.vue';
import ModelProviderManager from '../views/ModelProviderManager.vue';

const routes = [
  { path: '/', component: ChatViewV2, meta: { depth: 0 } },
  { path: '/chat/:id?', component: ChatViewV2, meta: { depth: 0 } },
  { path: '/monitor', component: AgentMonitor, meta: { depth: 1 } },
  { path: '/agent-monitor', component: AgentMonitor, meta: { depth: 1 } },
  { path: '/agent-config', component: AgentConfig, meta: { depth: 1 } },
  { path: '/mcp', component: MCPManager, meta: { depth: 1 } },
  { path: '/vector-library', component: VectorLibraryManager, meta: { depth: 1 } },
  { path: '/model-providers', component: ModelProviderManager, meta: { depth: 1 } },
  { path: '/:pathMatch(.*)*', redirect: '/' },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

export default router;
