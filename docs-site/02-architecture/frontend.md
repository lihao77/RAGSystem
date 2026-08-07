# 前端架构

本章拆解 `frontend-client` 的架构。所有结论基于 `frontend-client/src/` 的实际目录结构与 `router/index.js`、`main.js`。

## 技术栈

来自 `frontend-client/package.json`：

| 维度 | 选型 |
|------|------|
| 框架 | Vue 3（`vue ^3.5.24`） |
| 构建 | Vite 7（`vite ^7.2.4`） |
| 路由 | vue-router 4（`^4.6.4`） |
| 状态 | Pinia 3（`^3.0.4`） |
| UI | TailwindCSS 3 + `reka-ui` + `@lucide/vue` |
| 可视化 | ECharts 6 + MapLibre GL |
| 渲染 | markdown-it / marked + highlight.js |
| HTTP | axios |
| 工具 | `@vueuse/core`、`vue-virtual-scroller` |
| 共享契约 | `@ragsystem/agent-protocol`（与后端共用事件/类型） |

## 入口

`src/main.js`：

```js
createApp(App).use(createPinia()).use(router).mount('#app')
```

## 目录结构

```
frontend-client/src/
├── main.js                  # 入口
├── App.vue
├── router/index.js          # 单一路由文件，子路由带 pageMeta
├── layouts/
│   ├── MainLayout.vue
│   └── AdminLayout.vue
├── views/                   # 功能页面（单文件 .vue）
├── components/              # 通用组件
│   ├── admin/
│   ├── chat/
│   ├── icons/
│   ├── input-renderers/
│   ├── ui/                  # shadcn-vue 风格基础组件
│   └── workpanel/
├── stores/                  # Pinia store
├── composables/             # 组合式函数（~35 个）
├── api/                     # axios 封装，按域分文件
├── navigation/adminNavigation.js
├── utils/
├── lib/
├── styles/
└── assets/
```

## 路由

`router/index.js` 定义单一 `MainLayout` 布局，所有 view 懒加载（`() => import(...)`）。每个路由带 `pageMeta`：

```js
const pageMeta = (mainView, depth, pageOrder = depth, extra = {}) => ({
  mainView, pageKey: mainView, depth, pageOrder, ...extra,
})
```

管理类页面额外带 `section: 'admin'`（`adminPageMeta`）。

### 路由表

| 路径 | View | 说明 |
|------|------|------|
| `/` | `ChatViewV2` | 聊天主页 |
| `/chat/:id?` | `ChatViewV2` | 指定会话聊天 |
| `/admin` | `AdminCenter` | 管理中心聚合 |
| `/monitor` | `AgentMonitor` | 执行监控 |
| `/team-builder` | `TeamBuilder` | Team 编排 |
| `/agent-config` | `AgentConfig` | Agent 配置 |
| `/mcp` | `MCPManager` | MCP 管理 |
| `/knowledge-base` | `KnowledgeBaseManager` | 知识库 |
| `/skill-library` | `SkillLibrary` | 技能库 |
| `/model-providers` | `ModelProviderManager` | 模型 Provider |
| `/daemon` | `DaemonManager` | 守护 Agent |
| `/system-config` | `SystemConfig` | 系统配置 |
| `/:pathMatch(.*)*` | — | 兜底重定向到 `/` |

`/agent-monitor` 当前重定向到 `/monitor`（`router/index.js:43`）。

## 功能页面（views）

| View | 职责 |
|------|------|
| `ChatViewV2.vue` | 聊天主界面，会话/消息运行时核心 |
| `AdminCenter.vue` | 管理中心聚合仪表盘（数据分析面板） |
| `AgentMonitor.vue` | Agent 执行实时监控 |
| `TeamBuilder.vue` | Team 多智能体编排 |
| `AgentConfig.vue` | Agent 配置（最大的管理页之一） |
| `MCPManager.vue` | MCP 服务器管理（tools/resources/prompts 三件套） |
| `KnowledgeBaseManager.vue` | 知识库/向量库管理（最大文件，含 vectorizer/reranker） |
| `SkillLibrary.vue` | 技能库管理 |
| `ModelProviderManager.vue` | 模型 Provider 配置 |
| `DaemonManager.vue` | 守护 Agent 管理 |
| `SystemConfig.vue` | 系统配置 |

## 状态管理（Pinia stores）

`src/stores/` 下的 store 按域划分：

| Store | 职责 |
|-------|------|
| `session-list` | 会话列表 |
| `session-run` | 当前会话运行时状态 |
| `dictionaries` | 字典数据 |
| `mcp` | MCP 状态 |
| `llm` | LLM/Provider 状态 |
| `theme` | 主题 |
| `user` | 用户 |

## 组合式函数（composables）

`src/composables/` 是前端逻辑复用的核心，约 35 个，多数带 `.test.js`。核心围绕**会话/消息运行时**：

| Composable | 职责 |
|------------|------|
| `useSessionAgentClient` | 会话 Agent 客户端（+ 事件/send 测试） |
| `useChatMessageRuntime` | 聊天消息运行时 |
| `useMessageExecution` | 消息执行 |
| `useMessageListView` | 消息列表视图 |
| `useApprovalQueue` | 审批队列 |
| `useRunRuntime` | 运行运行时 |
| `useSessionRuntimeStatus` | Session runtime 清理与上下文快照加载；生命周期由 WebSocket `session.runtime` 驱动 |
| `useSessionFilesAttachments` | 会话文件附件 |
| `useCommandPalette` | 命令面板 |
| `useGlobalHotkeys` | 全局快捷键 |
| `useWorkbenchLayout` | 工作台布局 |

## API 层（api/）

axios 封装，按域分文件，与后端路由前缀对应：

| 文件 | 对应后端前缀 |
|------|-------------|
| `http.js` | axios 实例与拦截器 |
| `session.js` | `/api/agent/sessions` |
| `agentConfig.js` | `/api/agent-config` |
| `mcpService.js` | `/api/mcp` |
| `modelAdapter.js` | `/api/model-adapter` |
| `vectorLibrary.js` | `/api/knowledge-bases` |
| `sessionFiles.js` | 会话文件 |
| `skillLibrary.js` | `/api/skills` |
| `systemConfig.js` | `/api/system-config` |
| `daemon.js` | `/api/daemon` |
| `artifact.js` | `/api/artifacts` |
| `analytics.js` | `/api/agent/analytics` |
| `monitoring.js` | `/api/agent/monitoring` |
| `permissions.js` | 前端权限状态封装；后端权限决策由 Runtime 内部 `PermissionPolicyService` 执行 |

## 与后端的契约共享

前端依赖 `@ragsystem/agent-protocol` 和 `@ragsystem/api-contracts`（`package.json` dependencies），与后端共用事件类型、执行树结构、会话 socket 协议以及 REST schema。详见 [共享协议包](/05-sdk/shared-packages)。
