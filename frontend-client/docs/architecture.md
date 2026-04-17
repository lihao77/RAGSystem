# 前端架构总览

> 变更前端代码后请同步更新本文档。
>
> 相关规划：
> - [`../../docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md`](../../docs/refactor/CLAUDE_CODE_ALIGNMENT_PLAN.md) — Claude Code 对标演进路线图
> - [`../../docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md`](../../docs/refactor/TOOLING_GAP_ANALYSIS_VS_CLAUDE_CODE.md) — 工具体系差异分析

## 技术栈

Vue 3 + Vue Router 4 + Axios + ECharts 6 + Leaflet 1.9 + Markdown-it + Highlight.js

## 目录结构

> 下方目录树只列当前主线关键组件与模块，不是完整文件清单。

```
frontend-client/src/
├── views/                     # 页面视图
│   ├── ChatViewV2.vue         # 主聊天界面，承载 SSE、消息流与执行树投影
│   ├── AgentMonitor.vue       # 监控页
│   ├── TeamBuilder.vue        # Team 编排页
│   ├── AgentConfig.vue        # Agent 配置页
│   ├── MCPManager.vue         # MCP 管理页
│   ├── VectorLibraryManager.vue # 向量库页
│   └── ModelProviderManager.vue # 模型 Provider 页
├── layouts/                   # 页面壳层
│   └── MainLayout.vue         # sidebar + 右侧主卡片壳层
├── components/                # 可复用组件
│   ├── MapRenderer.vue        # Leaflet 地图渲染
│   ├── ChartRenderer.vue      # ECharts 图表渲染
│   ├── VisualizationLoader.vue # 异步加载可视化 artifact
│   ├── SituationScreen.vue    # 态势大屏（Teleport to body）
│   ├── FloatingChatPanel.vue  # 浮动对话面板
│   ├── SubtaskStatusTicker.vue # 任务状态滚动条
│   ├── HierarchicalExecutionTree.vue # 层次化执行树
│   ├── ExecutionNode.vue      # 单个执行节点
│   ├── MessageEditBox.vue     # 消息原地编辑组件
│   ├── ChatInput.vue          # 消息输入框
│   ├── ApprovalDialog.vue     # 工具审批确认
│   ├── PermissionModeSelector.vue # 权限模式与 auto-accept 规则切换
│   ├── SessionFilesDrawer.vue # 输入区/编辑态附件抽屉
│   ├── ContextSnapshotDrawer.vue # 上下文快照抽屉
│   ├── ExecutionDiagnosticsDrawer.vue # 执行诊断抽屉
│   └── ...
├── api/                       # API 调用模块
│   ├── monitoring.js          # 监控、审批、执行状态 API
│   ├── agentConfig.js         # Agent 配置
│   ├── permissions.js         # 全局权限策略
│   ├── sessionFiles.js        # session 文件
│   ├── mcpService.js          # MCP 服务
│   ├── modelAdapter.js        # 模型适配器
│   └── vectorLibrary.js       # 知识库
├── router/index.js            # 路由配置
├── utils/                     # executionProjector、markdown 等工具函数
└── main.js                    # 应用入口
```


前端 API 请求默认统一使用相对路径 `/api/*`。开发环境通过 `vite.config.js` 中的 dev server proxy 转发到 `VITE_API_PROXY_TARGET`（默认 `http://localhost:5001`）；Docker/生产环境则由前端容器内的 nginx 负责把 `/api/*` 反向代理到 docker-compose 网络中的 `backend:5001`。因此前端业务代码不应写死 `localhost:5001` 之类绝对地址，而应始终请求 `/api/*`，避免开发与部署环境分叉。

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
| `/daemon` | MainLayout → DaemonManager | 守护 Agent 系统页，统一管理基础配置、平台凭证、Cron 任务与主动推送 |

## WebSocket 实时通信

### 核心流程

```text
handleSend({ content, attachments })
  → ensureSession()                    # 获取/创建会话
      ├─ 读取新会话初始化参数：workspace_root / entry_agent
      └─ POST /api/agent/sessions      # 持久化 session metadata；若未提供 workspace_root，后端运行时仍会回退到默认 session workspace
  → 附件面板（SessionFilesDrawer 已改造成输入区附件对话框）
      ├─ 先走 /api/agent/sessions/{session_id}/files/upload 上传到 session 文件池
      └─ 把返回文件记录收敛到 pendingAttachments（消息级附件）
  → connectSessionWS(sessionId)        # 会话激活时建立单一持久 WS 连接
  → POST /api/agent/stream             # 发起执行请求，body = { task, attachments[], session_id, selected_llm }
      ├─ 返回 JSON { started, run_id, task_id, request_id, kind }
      └─ 后端按附件类型分流：图片继续自动进入多模态模型；普通文件只作为引用保留，由 agent 按需读取
  → handleWSMessage()                  # 统一处理 WebSocket 事件
      ├─ reconnect_start / reconnect_end：run 回放边界
      ├─ 消息流：output.chunk / output.final_answer / output.message_saved
      ├─ 执行树流：execution.step → executionProjector.applyStep()
      ├─ 审批/输入：user.approval_required / user.input_required
      ├─ 命令结果：command.result
      └─ scrollToBottom()
  → run 结束 → _finalizeActiveRun() + refreshSessionExecutionState()
  → checkSituationScreenTrigger()
  → cacheMessages()

loadSessionMessages(sessionId)
  → GET /api/agent/sessions/{session_id}/messages?limit=500&offset=0
      └─ 历史消息默认只返回 message 主载荷；assistant message 通过 has_execution 标记是否可懒加载 execution steps
  → createAssistantMessageFromHistory(item)
      └─ 若 has_execution=true，则按需调用 GET /api/agent/sessions/{session_id}/messages/{message_id}/run-steps
          并将返回 steps 交给 executionProjector.buildExecutionState()
```

### 执行树 projector

`src/utils/executionProjector.js` 是执行树唯一 projector，统一消费历史与实时的 canonical `execution.step.data`。

当前前端执行树来源拆成两条路径：
- 实时 / reconnect：继续直接消费 SSE `execution.step`
- 历史消息：先加载 message 主载荷，再按 assistant message 的 `has_execution` 标记懒加载 `/messages/{message_id}/run-steps`，最后交给同一个 projector 构建视图

- `createExecutionState()`：创建增量投影状态
- `buildExecutionState(steps)`：按需对单条历史 assistant message 的 canonical step 列表做全量投影；默认不在整页历史加载时为所有消息预构建
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
- `AgentMonitor.vue`、`MCPManager.vue`、`ModelProviderManager.vue`、`VectorLibraryManager.vue`、`AgentConfig.vue`、`TeamBuilder.vue`、`DaemonManager.vue` 都作为 `MainLayout` 的子路由渲染到同一个右侧主卡片内
- 所有非 Chat 页面统一通过 `components/PageLayout.vue` 承载页头，页头视觉参考 Chat 顶部控制栏：采用左右分组、玻璃胶囊操作区与移动端统一工具条风格，但不复用 Chat 专属控件结构
- `DaemonManager.vue` 采用与其他管理页一致的 `PageLayout + glass card + badge/act-btn/form-control/modal-shell` 体系，并通过 `/api/daemon/config` 读写 daemon YAML：页面内含基础配置（enabled/default_session_ttl/agent_name/heartbeat_interval）、平台凭证编辑（微信/钉钉/飞书）、适配器状态、Cron 管理与主动推送；其中飞书平台额外支持 `receive_mode` 选择，可在“长连接（推荐，无需公网）”与“Webhook（需要公网 HTTPS）”之间切换。Cron 列表与 CRUD 操作统一落到后端 `daemon.yaml` 的 `agents[].cron_tasks[]`，并遵守“同一平台只能被一个 enabled team 占用”的后端约束
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
- 历史消息列表默认不再内联 `execution_steps`；会先取 `/sessions/{session_id}/messages`，再按 `has_execution` 懒加载对应 message 的 run steps sidecar
- reconnect 回放与历史 run steps 懒加载都复用同一个 projector

### WebSocket 事件类型处理

前端执行树以 `execution.step` 为唯一事实来源，历史 / 实时 / reconnect 三条路径都走同一套 projector。

| 事件类型 | 处理逻辑 |
|---------|--------|
| `execution.step` | 交给 executionProjector 增量更新执行树 |
| `output.chunk` | 流式追加根最终答案 |
| `output.final_answer` | 标记根 assistant 消息完成 |
| `output.message_saved` | 补全消息 id/seq |
| `user.approval_required` | 进入本地审批队列，按 `approval_id` 去重后由队首驱动弹出审批对话框 |
| `user.approval_granted` / `user.approval_denied` | 作为审批 ack 事件：移除当前审批、清空提交锁，并自动切换到下一条待审批 |
| `user.input_required` | 弹出用户输入对话框 |
| `context.usage` | 更新上下文用量 |
| `context.compression_start` / `context.compression_summary` | 更新压缩状态与摘要占位 |
| `reconnect_start` / `reconnect_end` | 标记重连回放开始与结束 |
| `session.run_started` | 后台任务自动拉起系统 run 时，前端先插入 Background Task Notification 用户消息，再创建 assistant 占位并进入 running 状态 |
| `heartbeat` | 保持连接活性 |
| `agent.retry_scheduled` / `agent.end` | 更新 agent 生命周期提示 |
| `agent.error` | 添加错误状态 |
| `command.result` | 斜杠命令执行结果：原地修改占位 assistant 消息为 `role=system`，由 `CommandResultMessage.vue` 渲染 |
| `run.end` / `done` | 标记 run 结束并收尾当前 assistant 消息 |

说明：
- 不再使用 raw event 状态机构建执行树。
- 不再处理 `react.intermediate`。
- 不再依赖 `toolCallRegistry`、`executionStepsToExecutionState()`、`isSubtaskStartEvent()`、`isSubtaskEndEvent()` 这类兼容逻辑。
- 会话 URL 与页面切换统一由 Vue Router 驱动：聊天态使用 `/` 与 `/chat/:id?`，其中 `id` 为 `session_id`；管理页继续使用 `/agent-config`、`/mcp` 等独立路径，但这些路径共享同一个 `MainLayout` 壳层。

### 权限审批展示

- `PermissionModeSelector.vue` 仅负责全局权限模式与 auto-accept 规则，不与 session 绑定；同时提供独立的 `skip_all_approvals` 总开关。
- `skip_all_approvals` 在 UI 上表现为 switch 风格总开关，旁边使用 `i` 信息按钮展开说明；开启后外层 trigger 进入红色危险态并更新 tooltip，明确当前为“跳过所有审批”，同时“权限模式”列表进入置灰禁用态，仅保留展示，不允许再切换 mode，避免两个维度同时可编辑造成语义混淆。
- `dangerously_skip_permissions` 的前端中文语义统一为“跳过审批”，表示跳过常规风险 ask；`skip_all_approvals` 才是“跳过所有审批”的总开关，但仍保留工具执行权限 deny。
- `src/api/permissions.js` 统一调用全局 `/api/permissions/*` 接口，不传 session 参数。
- `ChatViewV2.vue` 在收到 `user.approval_required` 时会先把事件 data 收敛进本地审批队列，按 `approval_id` 去重，并始终只展示队首审批；收到 `user.approval_granted` / `user.approval_denied` 后再出队并自动切换下一条，避免多个待审批时只能处理第一条。
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

### 助手消息（UI 投影视图）

```javascript
{
  role: 'assistant',
  id: string, seq: number,
  content: string,               // 最终答案（流式拼接）
  has_execution: boolean,        // 是否存在可懒加载的 execution step sidecar
  subtasks: [],                  // 子任务列表
  execution_steps: [],           // 已懒加载并投影后的编排器执行步骤
  multimodalContents: [],        // 历史 execution.step 中的可视化内容
  status: [],                    // 错误状态
  finished: boolean,
  stopped: boolean,              // 已停止/中断
  metadata: {},                  // 原始 metadata，含 interrupted 等标记
  _executionProjector: object    // 仅运行时内存态，不持久化
}
```

### 斜杠命令结果消息

`command.result` SSE 事件到达后，占位 assistant 消息原地变形为：

```javascript
{
  role: 'system',
  content: string,               // 命令输出文本
  metadata: {
    type: 'command_result',
    command: string,             // 命令名（不含 /）
    success: boolean,
    error: string | null,
    data: object | null,         // 命令附带的结构化数据
  },
  finished: true,
}
```

由 `CommandResultMessage.vue` 渲染，显示命令名、状态图标和输出文本。

### 历史消息加载过滤规则

`loadSessionMessages()` 从 `/api/agent/sessions/{id}/messages` 取回全量消息后，按以下规则过滤：

| 条件 | 过滤原因 |
|------|--------|
| `metadata.visible_to_user === false && !metadata.display_only` | agent 专用消息（如展开后的完整 prompt），用户不可见 |
| `metadata.hidden === true` | 系统内部记录（中断标记等），前端不展示 |
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
  → viz_type == 'image' → 图片 / fallback 预览
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

### Skills 区块

Skills 列表不再按单一平铺数组展示，而是通过 `GET /api/agent-config/skills?workspace_root=...` 获取带来源语义的 Skill 元数据后分组渲染。当前接口会返回：

- `name`
- `display_name`
- `description`
- `source_type`
- `source_label`
- `is_auto_inject_candidate`

前端按来源分成三组：
- 工作区技能：来自 `<workspace_root>/.ragsystem/skills`，入口 Agent 默认可见，其他 Agent 需显式勾选。
- 全局技能：来自 `~/.ragsystem/skills`，只有显式勾选后才生效。
- 内置技能：来自后端内置 `agents/skills`。

每个 Skill 卡片展示来源 badge（`source_label`）；“自动注入”开关文案也已收敛为“自动注入内置/工作区技能”，避免误导用户以为全局 Skill 会被自动带入。

### workspace_root 透传

Agent 配置页会先加载当前 Agent 配置，再读取 `config.custom_params.workspace_root` 重新请求 `/api/agent-config/skills`，保证工作区 Skill 列表与当前 Agent 的工作区上下文一致。也就是说：

1. 选中 Agent。
2. 前端调用 `getAgentConfig(agentName)`。
3. 读取该 Agent 的 `custom_params.workspace_root`。
4. 调用 `getAvailableSkills(workspaceRoot)` 重新拉取 Skills。

保存时前端仍保持最小 schema：只写回 `skills.enabled_skills` 与 `skills.auto_inject`，不会额外保存 `source_type` 等派生字段。

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
- 权限模式文案与后端语义保持一致：`strict` 为严格档（全部风险工具需审批），`standard` 为默认档（中/高风险工具需审批），`relaxed` 为高风险档（仅高风险工具需审批）；三者在命中 auto-accept 规则时都可自动通过，`dangerously_skip_permissions` 表示“跳过审批”（仅跳过常规风险 ask，路径越界等 ask 仍可能触发）；前端下拉按“严格 → 默认 → 高风险 → 全开放”顺序展示
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
- 编辑用户消息时，文本与附件草稿统一由 `MessageEditBox.vue` 管理；确认后仍走 rollback + resend

| 操作 | 流程 |
|------|------|
| 加载会话 | 检查 messageCache → 未命中则 GET /api/agent/sessions/{id}/messages → 构建 subtasks/steps |
| 重连 | checkSessionTaskStatus() → 有运行中任务 → reconnectToRunningTask() |
| 流结束状态同步 | handleSend()/reconnect 收尾时单次 refreshSessionExecutionState() → 读取 `/task-status` + `/execution-diagnostics` |
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
