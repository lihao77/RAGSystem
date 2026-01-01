import { createRouter, createWebHistory } from 'vue-router'
import { usePageCache } from '@/composables/usePageCache'
import { checkConfigStatus, resetConfigStatusCache } from '@/composables/useConfigCheck'
import { ElMessageBox, ElMessage } from 'element-plus'

const routes = [
  {
    path: '/',
    name: 'home',
    component: () => import('../views/HomeView.vue'),
    meta: { 
      title: '首页', 
      cacheName: 'HomeView',
      requiresConfig: { neo4j: true }  // 需要 Neo4j 配置
    }
  },
  {
    path: '/split',
    name: 'split',
    component: () => import('../views/SplitView.vue'),
    meta: { 
      title: '综合视图', 
      keepAlive: true, 
      cacheName: 'SplitView',
      requiresConfig: { neo4j: true }  // 需要 Neo4j 配置
    }
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('../views/SearchView.vue'),
    meta: { 
      title: '实体查询', 
      keepAlive: true, 
      cacheName: 'SearchView',
      requiresConfig: { neo4j: true }  // 需要 Neo4j 配置
    }
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('../views/SettingsView.vue'),
    meta: { 
      title: '系统配置', 
      keepAlive: true, 
      cacheName: 'SettingsView'
      // 设置页不需要配置检查
    }
  },
  {
    path: '/nodes',
    name: 'nodes',
    component: () => import('../views/NodesView.vue'),
    meta: { 
      title: '节点系统', 
      keepAlive: true, 
      cacheName: 'NodesView'
      // 节点系统可能不需要配置
    }
  },
  {
    path: '/workflow',
    name: 'workflow',
    component: () => import('../views/WorkflowBuilderView.vue'),
    meta: { 
      title: '工作流编排', 
      keepAlive: true, 
      cacheName: 'WorkflowBuilderView',
      requiresConfig: { neo4j: true }  // 可能需要 Neo4j
    }
  },
  {
    path: '/files',
    name: 'files',
    component: () => import('../views/FilesView.vue'),
    meta: { 
      title: '文件管理', 
      keepAlive: true, 
      cacheName: 'FilesView'
      // 文件管理可能不需要配置
    }
  },
  {
    path: '/graphrag',
    name: 'graphrag',
    component: () => import('../views/GraphRAGView.vue'),
    meta: { 
      title: 'GraphRAG 问答', 
      keepAlive: true, 
      cacheName: 'GraphRAGView',
      requiresConfig: { neo4j: true, llm: true }  // 需要 Neo4j 和 LLM
    }
  },
  {
    path: '/vector',
    name: 'vector',
    component: () => import('../views/VectorManagement.vue'),
    meta: {
      title: '向量库管理',
      keepAlive: true,
      cacheName: 'VectorManagement',
      requiresConfig: { vector: true }  // 需要向量数据库配置
    }
  },
  {
    path: '/llm-adapter',
    name: 'llm-adapter',
    component: () => import('../views/LLMAdapterView.vue'),
    meta: {
      title: 'LLM Adapter 配置',
      keepAlive: true,
      cacheName: 'LLMAdapterView'
      // 设置页不需要配置检查
    }
  }
]

const router = createRouter({
  history: createWebHistory(),
  routes
})

router.beforeEach(async (to, from, next) => {
  // 设置页面标题
  document.title = to.meta.title ? `${to.meta.title} - 知识图谱可视化系统` : '知识图谱可视化系统'
  
  // 检查是否需要配置
  if (to.meta.requiresConfig) {
    try {
      const status = await checkConfigStatus()
      const requirements = to.meta.requiresConfig
      const missingItems = []
      
      // 检查各项要求
      if (requirements.neo4j && !status.neo4jConfigured) {
        missingItems.push('Neo4j 数据库')
      }
      
      if (requirements.vector && !status.vectorConfigured) {
        missingItems.push('向量数据库（嵌入模型）')
      }
      
      if (requirements.llm && !status.llmConfigured) {
        missingItems.push('LLM API')
      }
      
      // 如果有缺失项，弹出提示
      if (missingItems.length > 0) {
        try {
          await ElMessageBox.confirm(
            `访问"${to.meta.title}"需要以下配置：\n\n${missingItems.map(item => `• ${item}`).join('\n')}\n\n是否立即前往配置页面？`,
            '系统配置不完整',
            {
              type: 'warning',
              confirmButtonText: '前往配置',
              cancelButtonText: '取消',
              distinguishCancelAndClose: true,
              closeOnClickModal: false,
              center: true
            }
          )
          
          // 用户点击确定，跳转到设置页
          next('/settings')
          return
        } catch (error) {
          // 用户点击取消或关闭，阻止导航
          if (error === 'cancel' || error === 'close') {
            ElMessage.info('已取消访问')
            next(false)
            return
          }
        }
      }
    } catch (error) {
      console.error('配置检查失败:', error)
      // 检查失败不阻止导航
    }
  }
  
  next()
})

const { openTab } = usePageCache()
router.afterEach((to) => {
  openTab(to)
})

export default router