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

```text
handleSend()
  → ensureSession()                    # 获取/创建会话
  → POST /api/agent/stream             # 发起流式请求
  → processSSEStream()                 # 逐 chunk 解析 SSE 事件
      ├─ reader.read() 循环
      ├─ 事件序号 gap 检测（lastSeenSeq 追踪）
      ├─ 消息流：output.chunk / output.final_answer / output.message_saved
      ├─ 执行树流：execution.step → executionProjector.applyStep()
      └─ scrollToBottom()
  → 流结束 → checkSituationScreenTrigger()
  → cacheMessages()
```

### 执行树 projector

`src/utils/executionProjector.js` 统一消费历史与实时 execution steps：

- `buildExecutionState(steps)`：历史 assistant message 全量构建执行树视图模型
- `applyStep(state, step)`：实时增量应用单条 `execution.step`
- projector 输出：
  - `rawSteps`：统一 step 列表
  - `subtasks` / `execution_steps`：兼容旧 UI 的投影视图
  - `tree`：给 `HierarchicalExecutionTree` / `ExecutionNode` 的树模型
  - `ticker`：给 `SubtaskStatusTicker` 的当前活动/进度模型

`ChatViewV2.vue` 现在把消息流与执行树流拆开处理：

- 根最终答案、`message_saved`、可视化 ref 仍属于 message-first 链路
- 执行树仅消费 `execution.step`
- 历史消息加载和 reconnect 回放都复用同一个 projector

### SSE 事件类型处理

前端实时执行树以 `execution.step` 为唯一事实来源；`ChatViewV2.vue` 中保留的旧 SSE 分支仅用于兼容历史/重连路径，不再处理 `react.intermediate` 或各类别名事件。

| 事件类型 | 处理逻辑 |
|---------|--------|
| `execution.step` | 交给 executionProjector 增量更新执行树 |
| `output.chunk` | 流式追加根最终答案 |
| `output.final_answer` | 标记根 assistant 消息完成 |
| `output.message_saved` | 补全消息 id/seq |
| `user.approval_required` | 弹出审批对话框 |
| `user.input_required` | 弹出用户输入对话框 |
| `context.usage` | 更新上下文用量 |
| `agent.error` | 添加错误状态 |
| `done` | 标记流结束 |

旧事件兼容说明：
- 不再处理 `react.intermediate`。
- 工具调用只认 `call.tool.start/end`。
- thinking 事件只认 `agent.intent_delta/complete`，不再维护 `agent.thinking_*` 别名分支。

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
  _intentComplete: boolean       // 仅用于旧数据兼容去重
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
