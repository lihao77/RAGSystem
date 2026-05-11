# 前端 Agent 工作台改造计划

本文档定义 `frontend-client/` 从当前“聊天页 + 管理页集合”演进为“Agent 工作台”的实施路线。计划按小步可验收方式推进，避免一次性重写 `ChatViewV2.vue` 或改变后端协议。

## 目标

- 把聊天、运行过程、产物、审批、上下文和配置入口拆成清晰工作区。
- 降低 `ChatViewV2.vue` 与 `MainLayout.vue` 的复杂度，让后续功能可局部迭代。
- 保持现有 API、WebSocket 事件、`executionProjector` 和 artifact 渲染链路稳定。
- 优先提升高频路径：新建任务、查看运行状态、处理审批、查看结果、切换会话。

## 非目标

- 不重写后端 Agent 运行时。
- 不改 `execution.step` canonical 协议。
- 不迁移 Vue 技术栈。
- 不一次性替换所有管理页 UI。
- 不为了视觉风格引入新的重型 UI 框架。

## 当前主要问题

1. `ChatViewV2.vue` 承载会话路由同步、WebSocket、消息渲染、执行树、审批、附件、上下文抽屉和态势屏触发，单文件过重。
2. 左侧 sidebar 同时承载“会话历史”和“系统管理入口”，用户注意力被管理功能抢占。
3. 执行过程直接嵌入消息流，历史消息长、调试噪声重，最终回答和运行诊断边界不清晰。
4. 欢迎页偏展示性质，缺少工作区、入口 Agent、Team、模型和附件等任务启动动作。
5. 管理页虽然已收敛到 `PageLayout`，但列表、详情、表单、状态展示仍不够统一。
6. 全局视觉中过多 glass、blur、glow 和大圆角，桌面工具感不足。

## 设计原则

- 消息流只负责对话和最终结果，运行细节进入 Inspector。
- 导航先数据化，再做信息架构迁移。
- 大组件先拆只读展示组件，再迁移状态和副作用。
- 管理页优先统一结构，再统一视觉。
- 每个阶段都必须能独立构建、独立回滚。

## 阶段 0: 基线与导航数据化

状态: 已完成

目标:
- 建立本计划文档，作为后续前端改造的执行清单。
- 先把 `MainLayout.vue` 的管理入口按钮改为数据驱动，降低后续拆分侧栏/管理中心的改动成本。

范围:
- `frontend-client/docs/workbench-redesign-plan.md`
- `frontend-client/docs/README.md`
- `frontend-client/src/layouts/MainLayout.vue`

任务:
- [x] 新增前端工作台改造计划文档。
- [x] 将计划文档加入前端文档索引。
- [x] 将 sidebar 管理入口改为 `sidebarNavItems` 数据渲染。
- [x] 保持现有路由、按钮文案、active 规则和移动端行为不变。
- [x] 运行前端构建验证。

验收:
- `npm run build` 通过。
- 左侧管理入口顺序不变。
- 当前路由高亮行为不变。
- 新聊天和历史会话行为不变。

回滚点:
- 只需回滚 `MainLayout.vue` 与文档索引，不影响业务 API。

## 阶段 1: 聊天页工作台骨架

状态: 已完成

目标:
- 将聊天页从单一消息流改为“消息主区 + 可折叠运行 Inspector + 底部 Composer”。
- 初期只迁移展示位置，不改变数据来源。

范围:
- `ChatViewV2.vue`
- `components/workpanel/WorkPanel.vue` 及子组件，作为运行 Inspector 实现
- 新增 `components/chat/SessionContextBar.vue`
- 继续使用现有 `ChatInput.vue` 作为底部 Composer
- `styles/chat-view.css`

任务:
- [x] 新增右侧 `RunInspector` 容器，桌面端固定右侧，窄屏暂时隐藏。
- [x] 将当前 assistant 消息中的完整执行详情入口映射到 Inspector。
- [x] 消息流内默认只保留 `SubtaskStatusTicker` 摘要。
- [x] 顶部控制栏收敛为 `SessionContextBar`，展示模型、入口 Agent、工作区、权限和运行态。
- [x] 保持审批弹窗、用户输入弹窗、附件抽屉行为不变。

验收:
- 运行中任务能在 Inspector 看到执行树。
- 历史消息有 `has_execution` 时展开仍能懒加载 run steps。
- 移动端不出现横向溢出。
- 消息滚动和“滚动到底部”按钮仍绑定 `chat-messages-wrapper`。

回滚点:
- 保留原消息内执行详情渲染代码一个阶段，Inspector 稳定后再删除。

## 阶段 2: `ChatViewV2.vue` 组件拆分

状态: 已完成

目标:
- 降低聊天页单文件复杂度。
- 把展示组件和副作用逻辑分层。

拆分目标:
- `components/chat/ChatMessageList.vue`
- `components/chat/ChatMessageItem.vue`
- `components/chat/AssistantMessage.vue`
- `components/chat/UserMessage.vue`
- `components/chat/RunInspector.vue`
- `components/chat/SessionContextBar.vue`
- `components/chat/ApprovalQueueHost.vue`
- `components/chat/ArtifactPanel.vue`

任务:
- [x] 先拆消息展示组件，props 输入 `visibleMessages`、当前 session 和操作回调。
- [x] 再拆 markdown copy、message action、编辑态展示。
- [x] 把审批队列展示移入 `ApprovalQueueHost`，状态仍暂由 `ChatViewV2` 持有。
- [x] 把 artifact / visualization 入口移入 `ArtifactPanel` 或 Inspector tab。

验收:
- `ChatViewV2.vue` 行数明显下降。
- 原有组件测试通过。
- 不引入跨组件隐式事件总线。

## 阶段 3: 欢迎页改为任务启动器

目标:
- 首页空会话状态从品牌展示改为可操作的任务启动界面。

功能:
- 工作区路径输入。
- 入口 Agent 选择。
- Team 信息展示。
- 模型选择。
- 附件入口。
- 最近任务和常用任务模板。

任务:
- [x] 新增 `components/chat/TaskLauncher.vue`。
- [x] 复用现有 `pendingWorkspaceRoot`、`pendingEntryAgent`、`entryAgentOptions`。
- [x] 将欢迎页 logo 与 subtitle 降级为小型品牌标识。
- [x] 提供常用任务模板，不直接写死后端依赖。

验收:
- 空会话首屏可完成任务启动前的主要配置。
- 新建 session 仍由 `ensureSession()` 负责。
- 任务模板只填充输入框，不自动发送。

## 阶段 4: 侧栏信息架构调整

状态: 已完成

目标:
- 左侧侧栏聚焦会话和工作区。
- 管理入口收敛到单独的管理中心。

方案:
- sidebar 顶部: 新聊天、当前 Team/工作区摘要。
- sidebar 中部: 会话历史。
- sidebar 底部: 管理中心入口、系统状态、版本。
- 管理中心页内展示模型、Agent、Team、MCP、知识库、监控、守护系统、系统配置。

任务:
- [x] 新增 `/admin` 或 `/settings` 管理中心路由。
- [x] 将现有管理入口数据迁移到管理中心卡片/列表。
- [x] sidebar 只保留一个“管理中心”入口。
- [x] 保持旧路径可直接访问。

验收:
- 会话历史在桌面端获得更多空间。
- 旧路由不破坏。
- 移动端菜单层级更短。

## 阶段 5: 管理页控制台化

状态: 完成

目标:
- 统一管理页的密度、列表、详情、表单和状态表达。

任务:
- [x] 抽象 `EntityListLayout` 或轻量复用模式: 列表 + 详情 + 操作区。
- [x] 统一 `badge`、`act-btn`、`form-control`、空态、错误态。
- [x] 优先改 `ModelProviderManager` 和 `MCPManager`，因为它们最接近基础设施配置。
- [x] 再改 `AgentConfig`、`TeamBuilder`、`VectorLibraryManager` 首轮控制台化。

验收:
- 管理页首屏信息密度提升。
- 搜索、筛选、创建、编辑、删除、测试行为位置一致。
- 移动端仍有可用的单列布局。

## 阶段 6: 视觉收敛

状态: 完成

目标:
- 从强装饰 glass 风格收敛到稳定的桌面工具风格。

任务:
- [x] 减少全局 glow、blur、radial background 的存在感。
- [x] 控制卡片圆角，工具型容器优先 8px-12px。
- [x] 状态色只用于状态，不作为大面积装饰。
- [x] 保留深色/浅色主题变量，不改主题切换机制。
- [x] 为移动端和窄屏增加关键页面截图检查。

验收:
- 同一页面不再出现多层卡片嵌套感。
- 文本、按钮、badge 在暗色/亮色下对比稳定。
- 页面更像生产工具，而不是演示页。

## 阶段 7: 测试与回归清单

状态: 进行中

每个阶段至少执行:
- `npm run build`
- `npm test`
- `git diff --check`

关键布局改动额外执行:
- `npm run screenshot:smoke`

关键手工回归:
- 新聊天创建。
- 历史会话切换。
- 运行中切走再切回。
- 审批队列连续处理。
- 附件上传、粘贴、拖拽。
- artifact 图表/地图渲染。
- 移动端打开 sidebar、切页、发送消息。
- 暗色/亮色切换。

## 推荐实施顺序

1. 阶段 0: 文档与导航数据化。
2. 阶段 1: 聊天页工作台骨架。
3. 阶段 2: 消息展示组件拆分。
4. 阶段 3: 任务启动器。
5. 阶段 4: 侧栏和管理中心重分层。
6. 阶段 5: 管理页统一。
7. 阶段 6: 视觉收敛。
8. 阶段 7: 持续回归。

## 当前执行记录

- 2026-05-10: 建立工作台改造计划，开始阶段 0。
- 2026-05-10: 完成阶段 0。`MainLayout.vue` 的 sidebar 管理入口已改为 `sidebarNavItems` 数据渲染；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 完成阶段 1。右侧 `WorkPanel` 承载运行 Inspector；顶部控制栏收敛为 `SessionContextBar`；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 阶段 2 启动。新增 `ChatMessageList.vue` 与 `ChatMessageItem.vue`，先拆出消息展示外壳；`ChatViewV2.vue` 继续持有状态和副作用；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 阶段 2 继续拆分。新增 `MessageActions.vue`、`AssistantMessage.vue`、`UserMessage.vue`，消息操作、assistant 内容和用户消息编辑态展示已下沉到子组件；markdown copy 事件仍由消息 wrapper 代理，后续单独收敛；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 阶段 2 继续拆分。新增 `ApprovalQueueHost.vue`，承载右侧 `WorkPanel`、普通审批弹窗和用户输入弹窗；审批队列状态与提交逻辑仍由 `ChatViewV2.vue` 持有，文件预览确认弹窗暂保留在页面层；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 阶段 2 继续拆分。新增 `MarkdownContent.vue` 与 `utils/clipboard.js`，markdown 代码块/表格/引用复制逻辑从 `ChatViewV2.vue` 下沉到消息渲染组件；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 阶段 2 清理旧可视化兼容链路。移除 `[CHART:n]` 与 `multimodalContents` 历史格式支持，消息渲染仅保留 `[viz:artifact_id]`；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 完成阶段 2。新增 `ArtifactPanel.vue`，右侧工作栏展示当前消息中的 `[viz:artifact_id]` 产物入口；点击条目可定位到消息流中的内联可视化；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 继续下沉 `ChatViewV2.vue` 的会话入口、历史、创建与导出逻辑到 `useChatSessionController`，页面层仅保留编排与事件转发；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 继续下沉 `ChatViewV2.vue` 的审批队列与工作栏内联用户输入逻辑到 `useApprovalQueue`，保留 WS ack、HTTP 降级和队列轮转行为；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 继续下沉 `ChatViewV2.vue` 的 LLM 重试状态、倒计时 ticker 与消息状态同步到 `useLlmRetryState`；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 继续下沉 `ChatViewV2.vue` 的发送/停止链路到 `useSessionSend`，保留运行中状态检查、附件物化、WS/REST fallback 和 active run 初始化；`npm run build` 与 `npm test` 通过。
- 2026-05-11: 继续剥离 `ChatViewV2.vue` 的纯视图派生逻辑。新增 `useMessageListView`、`useRuntimeStatusView`、`useTaskNotifications`，将压缩摘要可见列表、消息复制、上下文用量/执行状态文案和后台任务通知解析移出页面层；同时把工作栏用户输入路由并入 `useApprovalQueue`。
- 2026-05-11: 继续收敛 `ChatViewV2.vue` 的运行时接线。新增 `useChatMessageRuntime` 聚合消息执行、工作栏选择和后台通知逻辑；`useSessionRunStream` 改为支持按 state/messageStore/sessionStatus/connection/retry/execution/approvals 等分组依赖；新增 `useActiveRunState` 承载 active run 初始状态。
- 2026-05-11: 阶段 3 完成。新增 `TaskLauncher.vue` 作为空会话任务启动器，复用入口 Agent、工作目录、Team、模型和附件状态；常用任务模板只填充输入框，不自动创建 session 或发送；移除底部 Composer 上方重复的空会话入口配置行。
- 2026-05-12: 阶段 4 完成。新增 `/admin` 管理中心页与共享管理导航数据，侧栏管理入口收敛为底部单一“管理中心”入口，并在顶部展示当前 Team/工作区摘要；模型、Agent、Team、MCP、知识库、监控、守护系统和系统配置旧路径保持直达；`npm run build` 与 `npm test` 通过。
- 2026-05-12: 阶段 5 启动。新增 `EntityListLayout.vue` 与 `admin-console.css` 作为管理页控制台基础结构；`ModelProviderManager` 的 Provider 列表和 `MCPManager` 的已安装服务列表接入共享列表/状态容器，MCP 服务首屏从卡片网格收敛为行式控制台列表。
- 2026-05-12: 阶段 5 继续推进。扩展 `admin-console.css` 的 `adm-form-*`、`adm-modal-*`、`adm-button-*` 原子类；`ModelProviderManager` 的创建/编辑/删除弹窗接入共享表单与模态结构，`MCPManager` 的 Registry 安装、服务编辑和工具查看模态接入共享模态结构。
- 2026-05-12: 阶段 5 继续推进。`TeamBuilder` 的加载/错误态、KPI 与 Team 列表接入共享控制台结构，Team 卡片收敛为行式列表；`AgentConfig` 的加载/错误/空态与新建/删除 Agent 弹窗接入共享状态、模态、表单和按钮类；`VectorLibraryManager` 的统计卡和索引/新增向量化器/迁移弹窗接入共享 KPI 与模态按钮类。
- 2026-05-12: 阶段 5 完成。`VectorLibraryManager` 的表格操作、状态徽标和加载/空态补齐共享类；`DaemonManager` 的状态概览、操作按钮、空态和弹窗接入 `adm-*` 控制台基础类；`SystemConfig` 的加载/错误态改为共享状态容器，`AgentConfig`、`MCPManager`、`AgentMonitor` 的局部空态完成补齐。
- 2026-05-12: 阶段 6 启动。全局视觉 token 收敛为低透明、低阴影、无 glow；移除 body radial 环境光并降低网格背景存在感；`PageLayout` 通用按钮、菜单和 `pl-card` 从 glass/pill/抬升风格改为 8px-12px 工具型控件；移动端 sidebar 去除 blur 并降低阴影。
- 2026-05-12: 阶段 6 完成。管理页 KPI 图标、平台图标和辅助标识收敛为中性工具样式，局部渐变主按钮改为扁平主按钮；`VectorLibraryManager` 移除与激活提示条重复的“激活向量化器” KPI 卡，并修正移动端工具栏换行；已用 headless Chrome 生成 `screenshots/stage6-team-builder-mobile.png`、`screenshots/stage6-vector-library-mobile.png`、`screenshots/stage6-mcp-narrow.png`、`screenshots/stage6-daemon-narrow.png`；`npm run build`、`npm test`、`git diff --check` 通过。
- 2026-05-12: 阶段 7 启动。新增 `npm run screenshot:smoke`，自动启动 Vite、调用本机 Chrome/Edge，对 Team、知识库、MCP、守护 Agent 的移动端/窄屏关键路径生成截图并做非空校验；`screenshots/` 加入忽略列表，避免 smoke 产物污染工作树；知识库移动端 Tab 改为 2x2 工具型分段布局。
- 2026-05-12: 阶段 7 继续增强。`npm run screenshot:smoke` 改为通过 Chrome DevTools Protocol 驱动页面，同步校验 `document.scrollWidth` 是否超过视口，能在截图生成时直接拦截横向溢出回归；四个 smoke 页面均通过。
- 2026-05-12: 阶段 7 继续收敛页面风格。管理类页面在 900px 以下提前使用覆盖式侧栏，避免窄屏主内容被挤压；`MCPManager` 与 `VectorLibraryManager` 的 Tab 导航接入共享 `adm-tabs` 工具型分段控件，移除局部 glass/blur 样式和重复响应式规则；`npm run build`、`npm test`、`npm run screenshot:smoke`、`git diff --check` 通过。
