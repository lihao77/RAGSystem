import { createRouter, createWebHistory } from 'vue-router'
import { usePageCache } from '@/composables/usePageCache'

const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
    meta: { title: '首页', cacheName: 'HomeView' }
  },
  // {
  //   path: '/graph',
  //   name: 'graph',
  //   component: () => import('../views/GraphView.vue'),
  //   meta: { title: '知识图谱' }
  // },
  // {
  //   path: '/map',
  //   name: 'map',
  //   component: () => import('../views/MapView.vue'),
  //   meta: { title: '地理视图' }
  // },
  {
    path: '/split',
    name: 'split',
    component: () => import('../views/SplitView.vue'),
    meta: { title: '综合视图', keepAlive: true, cacheName: 'SplitView' }
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('../views/SearchView.vue'),
    meta: { title: '实体查询', keepAlive: true, cacheName: 'SearchView' }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { title: '系统配置', keepAlive: true, cacheName: 'SettingsView' }
  },
  {
    path: '/nodes',
    name: 'nodes',
    component: () => import('../views/NodesView.vue'),
    meta: { title: '节点系统', keepAlive: true, cacheName: 'NodesView' }
  },
  {
    path: '/workflow',
    name: 'workflow',
    component: () => import('../views/WorkflowBuilderView.vue'),
    meta: { title: '工作流编排', keepAlive: true, cacheName: 'WorkflowBuilderView' }
  },
  {
    path: '/files',
    name: 'files',
    component: () => import('../views/FilesView.vue'),
    meta: { title: '文件管理', keepAlive: true, cacheName: 'FilesView' }
  },
  // {
  //   path: '/import',
  //   name: 'import',
  //   component: () => import('../views/ImportView.vue'),
  //   meta: { title: '数据导入' }
  // },
  // {
  //   path: '/evaluation',
  //   name: 'evaluation',
  //   component: () => import('../views/EvaluationView.vue'),
  //   meta: { title: '图谱评估' }
  // },
  {
    path: '/graphrag',
    name: 'graphrag',
    component: () => import('../views/GraphRAGView.vue'),
    meta: { title: 'GraphRAG 问答', keepAlive: true, cacheName: 'GraphRAGView' }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach((to, from, next) => {
  // 设置页面标题
  document.title = to.meta.title ? `${to.meta.title} - 知识图谱可视化系统` : '知识图谱可视化系统'
  next()
})

const { openTab } = usePageCache()
router.afterEach((to) => {
  openTab(to)
})

export default router