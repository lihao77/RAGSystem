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
      ├─ 读取新会话初始化参数：workspace_root / entry_agent
      └─ POST /api/agent/sessions      # 持久化 session metadata
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

`src/utils/executionProjector.js` 是执行树唯一 projector，统一消费历史与实时的 canonical `execution.step.data`：

- `createExecutionState()`：创建增量投影状态
- `buildExecutionState(steps)`：历史 assistant message 全量构建执行树视图模型
- `applyStep(state, step)`：实时 / reconnect 增量应用单条 canonical step

projector 输出并维护：

- `rawSteps`：canonical step 列表
- `subtasks` / `execution_steps`：兼容当前 UI 组件的投影视图
- `multimodalContents`：从 `kind=visualization` step 投影出的历史可视化内容
- `pendingToolCallsByParentCallId`：子 agent tool 先于 `subtask start` 到达时的最小乱序缓冲

tool 归属规则：

- 子 agent 的 tool 优先按 `parent_call_id -> subtaskMap` 归入对应 `subtask`
- 若 `subtask start` 还未到达，则先暂存到 `pendingToolCallsByParentCallId`，待 subtask 建立后立即回填
- 根级 `kind=run` 会先投影成一个 root execution step，占位表示“当前入口 agent 已启动”；后续同轮 `intent/tool` 会继续挂到这个根节点
- `buildExecutionState()` 与实时 `applyStep()` 共享同一套归属与回填逻辑，避免历史回放、实时流、reconnect 三条路径分叉

`ChatViewV2.vue` 现在把消息流与执行树流彻底拆开：

- 根最终答案、`message_saved`、`[viz:artifact_id]` 仍属于 message-first 链路
- 执行树只消费 `execution.step`
- 历史消息加载和 reconnect 回放都复用同一个 projector

### SSE 事件类型处理

前端执行树以 `execution.step` 为唯一事实来源，历史 / 实时 / reconnect 三条路径都走同一套 projector。

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

说明：
- 不再使用 raw event 状态机构建执行树。
- 不再处理 `react.intermediate`。
- 不再依赖 `toolCallRegistry`、`executionStepsToExecutionState()`、`isSubtaskStartEvent()`、`isSubtaskEndEvent()` 这类兼容逻辑。

## 消息数据结构

### 助手消息

```javascript
{
  role: 'assistant',
  id: string, seq: number,
  content: string,               // 最终答案（流式拼接）
  subtasks: [],                  // 子任务列表
  execution_steps: [],           // 编排器执行步骤
  multimodalContents: [],        // 历史 execution.step 中的可视化内容
  status: [],                    // 错误状态
  finished: boolean,
  _executionProjector: object    // 仅运行时内存态，不持久化
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
  status: 'running' | 'success' | 'error',
  run_status: 'running' | 'success' | 'error' | null,
  agent_name: string,
  agent_display_name: string,
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

`ChatViewV2.vue` 将新会话初始化参数保存在页面本地状态中：
- `pendingWorkspaceRoot`：创建 session 时写入 `metadata.workspace_root`
- `pendingEntryAgent`：创建 session 时写入 `metadata.entry_agent`（值必须是后端返回的真实 `agent_name`；空值仅表示“使用配置默认入口 Agent”，前端不应提交 `default` 这类 UI alias）

两者都只在 `!currentSessionId` 时展示和编辑；会话创建成功后，前端会从返回的 `session.metadata` 回填本地状态，并在历史会话切换 / 浏览器前进后退时继续恢复。

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
