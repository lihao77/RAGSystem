# 前端架构总览

> 变更前端代码后请同步更新本文档。
>
> 相关规划：
> - [`../../docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md`](../../docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md) — Claude Code 对标演进路线图
> - [`../../docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`](../../docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md) — 工具体系差异分析

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
│   ├── PermissionModeSelector.vue # 权限模式与 auto-accept 规则切换
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
| `/` `/chat/:id?` | MainLayout → ChatViewV2 | 通过公共壳层进入聊天页；`/chat/:id?` 中的 `id` 为 `session_id` |
| `/monitor` | MainLayout → AgentMonitor | 通过公共壳层在右侧主区渲染监控页 |
| `/agent-monitor` | 重定向到 `/monitor` | 兼容旧监控入口 |
| `/team-builder` | MainLayout → TeamBuilder | 通过公共壳层在右侧主区渲染 Team 方案编排页 |
| `/agent-config` | MainLayout → AgentConfig | 通过公共壳层在右侧主区渲染 Agent 配置页 |
| `/mcp` | MainLayout → MCPManager | 通过公共壳层在右侧主区渲染 MCP 管理页 |
| `/vector-library` | MainLayout → VectorLibraryManager | 通过公共壳层在右侧主区渲染知识库页 |
| `/model-providers` | MainLayout → ModelProviderManager | 通过公共壳层在右侧主区渲染模型 Provider 页 |

## SSE 流式通信

### 核心流程

```text
handleSend({ content, attachments })
  → ensureSession()                    # 获取/创建会话
      ├─ 读取新会话初始化参数：workspace_root / entry_agent
      └─ POST /api/agent/sessions      # 持久化 session metadata；若未提供 workspace_root，后端运行时仍会回退到默认 session workspace
  → 附件面板（SessionFilesDrawer 已改造成输入区附件对话框）
      ├─ 先走 /api/agent/sessions/{session_id}/files/upload 上传到 session 文件池
      └─ 把返回文件记录收敛到 pendingAttachments（消息级附件）
  → POST /api/agent/stream             # 发起流式请求，body = { task, attachments[], session_id, selected_llm }
      └─ 后端按附件类型分流：图片继续自动进入多模态模型；普通文件只作为引用保留，由 agent 按需读取
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
- `agentNameDisplayNameMap`：按 `agent_name -> agent_display_name` 记忆已见过的展示名；历史回放与 SSE 增量都复用同一映射规则，保证后续未显式携带 display name 的 step 仍保持中文展示

tool 归属规则：

- 子 agent 的 tool 优先按 `parent_call_id -> subtaskMap` 归入对应 `subtask`
- 若 `subtask start` 还未到达，则先暂存到 `pendingToolCallsByParentCallId`，待 subtask 建立后立即回填
- 根级 `kind=run` 会先投影成一个 root execution step，占位表示“当前入口 agent 已启动”；后续同轮 `intent/tool` 会继续挂到这个根节点
- 执行树根节点的正文仍只来自有 thought / intent 内容的 root step；但节点头部的 agent 名称会优先继承同轮最近一个带名称的 root step（通常是 `run` step），避免入口 agent 名称在前端回退成 `orchestrator_agent`
- `buildExecutionState()` 与实时 `applyStep()` 共享同一套归属与回填逻辑，避免历史回放、实时流、reconnect 三条路径分叉
- 所有 UI 展示 agent 名称时统一优先使用 `agent_display_name`，没有时再回退 `agent_name`；`SubtaskStatusTicker.vue` 与执行树节点都直接消费 projector 的投影结果，不再各自硬编码“编排器”等标签

`ChatViewV2.vue` 的消息滚动统一由 `chat-messages-wrapper` 承担；桌面端与移动端都复用同一个滚动容器，避免移动端再让内层 `chat-messages` 自己滚动，导致 `scrollToBottom()`、底部检测和按钮点击命中错误元素。

当前前端已改为“两层结构”：
- `MainLayout.vue` 负责左侧 sidebar、顶层路由承载，以及右侧统一的玻璃卡片主区（视觉上等价于原先的 `chat-main` 外壳）；它只负责卡片边框/背景与页面级滚动承载，不再给页面内容强加统一 padding
- `ChatViewV2.vue` 只负责聊天页本身，不再承担整个应用壳层职责；Chat 顶部保留专属的控制台式工具栏
- `AgentMonitor.vue`、`MCPManager.vue`、`ModelProviderManager.vue`、`VectorLibraryManager.vue`、`AgentConfig.vue`、`TeamBuilder.vue` 都作为 `MainLayout` 的子路由渲染到同一个右侧主卡片内
- 所有非 Chat 页面统一通过 `components/PageLayout.vue` 承载页头，页头视觉参考 Chat 顶部控制栏：采用左右分组、玻璃胶囊操作区与移动端统一工具条风格，但不复用 Chat 专属控件结构
- `AgentConfig.vue` 已收敛进 `PageLayout` 体系，不再维护独立的桌面/移动端头部实现
- `MainLayout.vue` 的左侧 sidebar 采用“按页面主视图唯一激活”规则：聊天入口与历史会话只在 `mainView=chat` 时参与高亮；模型管理 / Agent 配置 / MCP / 知识库 / 监控按钮按各自 `route.meta.mainView` 独立激活，避免管理页打开后历史会话残留 active。
- `AgentConfig.vue` 的 section-nav（右侧/底部浮动分节导航）点击跳转、高亮观察与“滚动到底部”统一绑定 `PageLayout.vue` 的 `.page-content-scroll` 作为真实滚动容器；不要再绑定到内部 `.page-content`，否则分节导航会出现失效或高亮不同步。
- 管理页的纵向滚动由 `MainLayout.vue` 的 `layout-main-host--page` 统一承载，内部 `route-card--page` 保持 `min-height: 100%` 且不裁剪 overflow，避免公共壳层把非 Chat 页面内容截断导致无法滚动
- 管理页的内容留白下沉到各页面自身：通用页面走 `components/PageLayout.vue` 的 embedded 模式，自定义页面自行定义边距，因此不同页面可以使用不同留白策略

这样侧边栏、聊天页、管理页都处于同一套卡片层级体系中，同时页面内边距由页面自己控制，避免公共壳层把所有管理页锁死为同一套留白。

`ChatViewV2.vue` 在消息区底部使用单一 `chat-messages-wrapper` 作为滚动容器，并在其底部放置一个 `bottom-dock` sticky 容器，内部同时承载输入区和“滚动到底部”按钮。按钮只用 JS 判断是否显示；位置完全由 CSS 控制，始终相对输入区使用 `bottom: calc(100% + 12px)` 悬浮，因此 textarea 自增高、附件预览展开、移动端输入区高度变化时都会自动跟随上移，不再依赖 `getBoundingClientRect()` 或 viewport/safe-area 的手工 bottom 计算。点击按钮时仍对消息容器执行平滑滚动，并在真正回到底部前保持按钮可见，避免闪烁。

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
| `user.approval_required` | 弹出审批对话框，原样透传后端事件 data（含 `permission_mode`、`approval_reason`） |
| `user.input_required` | 弹出用户输入对话框 |
| `context.usage` | 更新上下文用量 |
| `agent.error` | 添加错误状态 |
| `done` | 标记流结束 |

说明：
- 不再使用 raw event 状态机构建执行树。
- 不再处理 `react.intermediate`。
- 不再依赖 `toolCallRegistry`、`executionStepsToExecutionState()`、`isSubtaskStartEvent()`、`isSubtaskEndEvent()` 这类兼容逻辑。
- 会话 URL 与页面切换统一由 Vue Router 驱动：聊天态使用 `/` 与 `/chat/:id?`，其中 `id` 为 `session_id`；管理页继续使用 `/agent-config`、`/mcp` 等独立路径，但这些路径共享同一个 `ChatViewV2` 壳层。

### 权限审批展示

- `PermissionModeSelector.vue` 仅负责全局权限模式与 auto-accept 规则，不与 session 绑定。
- `src/api/permissions.js` 统一调用全局 `/api/permissions/*` 接口，不传 session 参数。
- `ChatViewV2.vue` 在收到 `user.approval_required` 时继续原样透传 `event.data` 给 `ApprovalDialog.show(...)`。
- `ApprovalDialog.vue` 对 `permission_mode` 与 `approval_reason` 做可选渲染，兼容旧审批事件；当前会额外读取 `approval_reason_codes`、`approval_secondary_reasons` 与 `approved_external_paths`，用于区分“风险审批”“路径越界审批”以及双重原因场景，并展示本次调用被授权的越界路径列表。
- `dangerously_skip_permissions` 的前端中文语义统一为“跳过审批”。

## 消息数据结构

### 用户消息

```javascript
{
  role: 'user',
  id: string, seq: number,
  content: string,
  attachments: [
    {
      file_id, original_name, stored_name, mime, size, kind
    }
  ],
  metadata: {
    attachments: []
  }
}
```

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

可视化 artifact 持久化在 `data/sessions/<session_id>/visualizations/` 下；后端不会再按时间自动清理该目录，只有在显式删除 session 时才会一起删除。

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

## Team 编排页

`TeamBuilder.vue` 负责“方案级”操作，而不是细粒度 agent 参数编辑：

- 展示当前 `active_team`
- 创建新的 team（可从 source team 复制整份配置）
- 删除、激活 team
- 从 source team 复制指定 agents 到目标 team
- 通过左右双栏的可视化装配区展示“来源 Team / 目标 Team / 待复制清单”，让复制操作从表单式选择升级为即时预览式组合
- 装配区会区分“预计新增”和“目标 Team 已存在”的 Agent，并提供全选可新增项 / 全选来源项等快捷操作
- 支持从 Team 卡片直接进入 `AgentConfig.vue`，继续编辑当前 team 对应配置文件里的 agent 细节

team 在前端中的语义是“命名的 agent 配置文件方案”，不是运行时 team 实体。

## Agent 配置页

`AgentConfig.vue` 负责展示和编辑当前 active_team 下 Agent 的基础配置、工具、Skills、MCP、委派与 Memory 能力。

其中 Memory 区块采用独立元数据接口而不是前端硬编码：
- 前端通过 `GET /api/agent-config/memory-metadata` 获取 memory 工具描述与 scope 说明
- Memory 工具卡片展示 `name + description`
- scope 权限按单个 scope 聚合展示，在同一张卡片中勾选“读取 / 写入 / 归档”三类权限，避免把同一组 scope 重复渲染三遍
- 保存时仍写回后端配置字段：
  - `memory.enabled`
  - `memory.auto_inject`
  - `memory.enabled_tools`
  - `memory.allowed_scopes`
  - `memory.write_scopes`
  - `memory.archive_scopes`


`ChatViewV2.vue` 将新会话初始化参数保存在页面本地状态中：
- 顶部右侧控制区新增 `PermissionModeSelector`，用于切换审批模式并维护 auto-accept 规则
- 权限模式文案与后端语义保持一致：`strict` 为严格档（全部风险工具需审批），`standard` 为默认档（中/高风险工具需审批），`relaxed` 为高风险档（仅高风险工具需审批）；三者在命中 auto-accept 规则时都可自动通过，`dangerously_skip_permissions` 则跳过所有权限检查；前端下拉按“严格 → 默认 → 高风险 → 全开放”顺序展示
- `pendingWorkspaceRoot`：创建 session 时写入 `metadata.workspace_root`
- `pendingEntryAgent`：创建 session 时写入 `metadata.entry_agent`（值必须是后端返回的真实 `agent_name`；空值仅表示“使用配置默认入口 Agent”，前端不应提交 `default` 这类 UI alias）
- `sessionFiles`：当前会话私有文件列表，通过 `/api/agent/sessions/{session_id}/files*` 维护；与知识库页使用的全局 `/api/files` 文件池严格分离
- `pendingAttachments`：仅底部输入框中新消息的待发送附件
- `editingDraft` / `editingAttachmentsDraft`：当前正在原地编辑的消息文本与附件草稿
- `sessionFilesDrawerTarget`：附件抽屉当前服务对象（底部输入框 composer 或消息原地编辑）

当前多模态输入约定：
- 顶部“会话文件”主入口已收敛，附件入口下沉到 `ChatInput.vue` 左侧按钮
- `ChatInput.vue` 现为双层输入结构：上层仅承载文本输入区，下层承载附件按钮、发送按钮、上下文预算与 execution pill 等状态操作区
- `ChatViewV2.vue` 通过 `ChatInput` 的 `footerMeta` slot 将上下文预算与执行状态注入输入框底部，而不是在输入框外单独渲染状态条
- `SessionFilesDrawer.vue` 同时服务底部输入区新消息附件和“消息气泡原地编辑”两种场景，通过本地 `target/mode` 区分操作目标
- 用户可以发送“纯文本”、“文本+附件”或“纯附件”消息
- 用户消息历史回放时，附件通过 `message.metadata.attachments` 重建并在消息气泡下方回显
- 编辑用户消息时，文本继续使用消息气泡内 `contenteditable`，附件也在消息气泡边上原地增删，确认后仍走 rollback + resend

| 操作 | 流程 |
|------|------|
| 加载会话 | 检查 messageCache → 未命中则 GET /api/agent/sessions/{id}/messages → 构建 subtasks/steps |
| 重连 | checkSessionTaskStatus() → 有运行中任务 → reconnectToRunningTask() |
| 编辑重发 | startEditMessage() 在消息气泡内初始化文本草稿与附件草稿 → 用户在气泡内原地修改文本与附件 → confirmEditAndResend() 调用 POST rollback → 通过 `/api/agent/stream` 以编辑后的内容和 `attachments[]` 重新流式发送 |
| 重试 | rollbackAndRetry() → POST rollback → 以原问题重新发送 |

## 主题系统

- 全局背景纹理由 `src/styles/main.css` 的 `body::after` 提供，页面级容器默认应保持透明或使用玻璃半透明背景，避免用 `var(--color-bg-app)` 之类实底整块覆盖，否则会遮挡点阵背景。
- 管理页统一通过 `components/PageLayout.vue` 承载页面外壳；其外层 `page-layout` 负责留白与滚动，不再提供实底背景，具体内容区域使用 `glass-card` / `var(--glass-bg)` 系列半透明面板承载。
- `PageLayout.vue` 的 embedded 模式支持按页面传入 `contentPadding` / `mobileContentPadding`，用于声明桌面端与移动端留白；需要特殊布局的页面（如 `AgentConfig.vue`）仍可完全自定义自己的边距实现。
- 若组件同时需要主题色实体面板与半透明玻璃面板，应显式区分：实体面板使用 `--color-bg-primary/secondary/tertiary/elevated`，玻璃面板使用 `--glass-bg` / `--glass-bg-light`；不要混用，避免浅色模式下出现仍偏暗的背景。
- 需要对玻璃面板做透明度微调时，优先基于 `--color-bg-elevated-rgb` 生成 `rgba(...)`，确保深浅主题都能同步切换。

CSS 变量驱动，支持亮色/暗色切换：

- 亮色：`data-theme="light"`
- 暗色：默认
- 切换：`emit('toggleTheme')`

关键变量：`--color-bg-*`, `--color-text-*`, `--color-border-*`, `--color-brand-*`, `--glass-*`, `--radius-*`
