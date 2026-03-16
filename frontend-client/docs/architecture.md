# 前端架构总览

> 变更前端代码后请同步更新本文档。

## 技术栈

Vue 3 + Vue Router 4 + Axios + ECharts 6 + Leaflet 1.9 + Markdown-it + Highlight.js

## 目录结构

```
frontend-client/src/
├── views/                     # 页面视图
│   └── ChatViewV2.vue         # 主聊天界面（~2600行，SSE 流式通信核心）
├── components/                # 可复用组件
│   ├── MapRenderer.vue        # Leaflet 地图渲染（~1200行）
│   ├── ChartRenderer.vue      # ECharts 图表渲染
│   ├── VisualizationLoader.vue # 异步加载可视化 artifact
│   ├── SituationScreen.vue    # 态势大屏（Teleport to body）
│   ├── SituationBar.vue       # 态势信息条
│   ├── FloatingChatPanel.vue  # 浮动对话面板
│   ├── SubtaskStatusTicker.vue # 任务状态滚动条
│   ├── HierarchicalExecutionTree.vue # 层次化执行树
│   ├── ExecutionNode.vue      # 单个执行节点
│   ├── MultimodalContent.vue  # 多模态内容渲染
│   ├── ChatInput.vue          # 消息输入框
│   ├── ApprovalDialog.vue     # 工具审批确认
│   ├── UserInputDialog.vue    # 用户输入请求
│   ├── LLMSelector.vue        # LLM 模型选择器
│   └── ...
├── api/                       # API 调用模块
│   ├── monitoring.js          # 监控、审批、执行状态 API
│   ├── agentConfig.js         # Agent 配置
│   ├── mcpService.js          # MCP 服务
│   ├── modelAdapter.js        # 模型适配器
│   └── vectorLibrary.js       # 知识库
├── router/index.js            # 路由配置
├── styles/                    # 全局样式（CSS 变量主题系统）
├── utils/                     # 工具函数
└── main.js                    # 应用入口
```

## 路由

| 路径 | 组件 | 说明 |
|------|------|------|
| `/` `/chat/:id?` | ChatViewV2 | 主聊天界面 |
| `/monitor` | AgentMonitor | 智能体监控 |
| `/agent-config` | AgentConfig | Agent 配置管理 |
| `/mcp` | MCPManager | MCP 服务管理 |
| `/vector-library` | VectorLibraryManager | 知识库管理 |
| `/model-providers` | ModelProviderManager | 模型提供商管理 |

## SSE 流式通信

### 核心流程

```
handleSend()
  → ensureSession()                    # 获取/创建会话
  → POST /api/agent/stream             # 发起流式请求
  → processSSEStream()                 # 逐 chunk 解析 SSE 事件
      ├─ reader.read() 循环
      ├─ 事件序号 gap 检测（lastSeenSeq 追踪）
      ├─ 按事件类型分发处理
      ├─ 更新 messages / subtasks / execution_steps
      └─ scrollToBottom()
  → 流结束 → checkSituationScreenTrigger()
  → cacheMessages()
```

### 事件序号 gap 检测

每个 SSE 事件携带 `seq`（全局递增序号），前端维护 `lastSeenSeq`：
- 普通事件：`event.seq > lastSeenSeq + 1` 时 console.warn 报告 gap
- 心跳事件：检查 `event.last_seq` 和 `event.dropped_count`，检测服务端丢弃情况

### SSE 事件类型处理

| 事件类型 | 处理逻辑 |
|---------|--------|
| `agent.intent_delta` | 流式追加意图到 `step.intent` |
| `agent.intent_complete` | 标记意图完成 |
| `react.intermediate` | 完整意图补发（同一 round 去重） |
| `tool.start` / `call.tool.start` | 创建工具调用对象 |
| `tool.end` / `call.tool.end` | 更新工具调用结果 |
| `subtask.start` / `call.agent.start` | 创建子任务卡片 |
| `subtask.end` / `call.agent.end` | 更新子任务状态 |
| `output.chunk` | 流式追加最终答案 |
| `output.final_answer` | 标记消息完成 |
| `output.message_saved` | 补全消息 id/seq |
| `user.approval_required` | 弹出审批对话框 |
| `user.input_required` | 弹出用户输入对话框 |
| `context.usage` | 更新上下文用量 |
| `agent.error` | 添加错误状态 |
| `done` | 标记流结束 |

## 消息数据结构

### 助手消息

```javascript
{
  role: 'assistant',
  id: string, seq: number,
  content: string,               // 最终答案（流式拼接）
  subtasks: [],                  // 子任务列表
  execution_steps: [],           // 编排器执行步骤
  multimodalContents: [],        // 可视化内容
  status: [],                    // 错误状态
  toolCallRegistry: Map,         // 工具调用注册表
  finished: boolean
}
```

### 子任务结构

```javascript
{
  task_id, agent_name, agent_display_name, description,
  react_steps: [],               // 执行步骤
  tool_calls: [],                // 工具调用
  result_summary: string,
  status: 'running' | 'success' | 'error',
  currentStep: object,
  ctx: { used, max }
}
```

### 执行步骤结构

```javascript
{
  round: number,
  intent: string,                // 意图/思考
  toolCalls: [],
  _intentComplete: boolean       // 去重标志
}
```

## 可视化 Artifact 渲染

```
AI final_answer 含 [viz:viz_abc123]
  → parseMessageParts() 解析占位符
  → VisualizationLoader 组件
  → GET /api/artifacts/visualizations/{artifact_id}
  → 返回 { viz_type, config, title, sub_type }
  → viz_type == 'chart' → ChartRenderer
  → viz_type == 'map'   → MapRenderer
```

### MapRenderer 支持的地图类型

heatmap / marker / circle / choropleth / geojson / bindmap / risk

### 态势大屏

自动触发条件：消息完成后，最新 artifact 的 map_type 为 `risk` 或 `bindmap`

```
SituationScreen (Teleport to body, z-index: 10000)
  ├─ SituationBar          # 顶部信息条（风险等级统计）
  ├─ MapRenderer            # 全屏地图（situationMode=true）
  └─ FloatingChatPanel      # 右侧浮动对话面板（可收起）
```

手动触发：MapRenderer 标题栏"进入态势大屏"按钮 → `emit('enter-situation')`

## 会话管理

| 操作 | 流程 |
|------|------|
| 加载会话 | 检查 messageCache → 未命中则 GET /api/agent/sessions/{id}/messages → 构建 subtasks/steps |
| 重连 | checkSessionTaskStatus() → 有运行中任务 → reconnectToRunningTask() |
| 编辑重发 | confirmEditAndResend() → POST rollback → 以编辑内容重新流式发送 |
| 重试 | rollbackAndRetry() → POST rollback → 以原问题重新发送 |

## 主题系统

CSS 变量驱动，支持亮色/暗色切换：

- 亮色：`data-theme="light"`
- 暗色：默认
- 切换：`emit('toggleTheme')`

关键变量：`--color-bg-*`, `--color-text-*`, `--color-border-*`, `--color-brand-*`, `--glass-*`, `--radius-*`
