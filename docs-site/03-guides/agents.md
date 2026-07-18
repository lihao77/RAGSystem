# Agent 与 Team

Agent 是 RAGSystem 的核心运行单元。本章基于 `backend-ts/src/services/agent/`、`routes/agent/` 与 `runtime-container.ts` 的真实实现，描述如何启动一次 Agent 会话及其背后的运行时组件。

## 核心组件

Agent 运行时由 `runtime-container.ts` 装配的多个协作服务构成：

| 组件 | 类 | 职责 |
|------|----|------|
| 执行引擎 | `AgentExecutionService` / `run-engine` | 工具循环、LLM 调用、事件产出 |
| 运行时核心 | `RuntimeCoreService` | agent 配置 + provider 解析 |
| 会话应用 | `AgentSessionApplication` | 会话生命周期 |
| 对话存储 | `conversationStore` | 消息/任务/metrics 持久化 |
| 委派 | `AgentDelegationService` | orchestrator 动态委派子 agent |
| 上下文压缩 | `AgentCompressionService` | 超长上下文滚动压缩 |
| 指标采集 | `AgentMetricsCollector` | 性能指标聚合 |
| 实时事件 | `RealtimeEventHub` + `OutboxDispatcher` | 终端事件投递 |
| 权限策略 | `PermissionPolicyService` | 工具调用审批 |
| 待交互 | `PendingInteractionService` | 工具向用户请求输入 |

::: tip 来源
全部组件在 `runtime-container.ts:112-247` 的 `createRuntimeContainer` 中实例化并互相注入。
:::

## 启动一次会话

### 流式启动

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/api/agent/stream` | 启动任务，返回 SSE 流（`registerStreamRoutes`） |

这是 Agent 执行的主入口，通过 Server-Sent Events 推送运行时事件（工具调用、思考、结果）。

### WebSocket 会话

| 方法 | 路径 | 说明 |
|------|------|------|
| `WS` | `/api/agent/ws` | 会话级 WebSocket（`registerSessionWebSocketRoute`） |

提供持久双向连接，用于实时事件推送与交互（审批、用户输入）。

### AG-UI 网关

| 方法 | 路径 | 说明 |
|------|------|------|
| — | `/api/agui` | AG-UI 协议网关（SSE + interrupt 状态机，`routes/agent/agui.ts`） |

`registerAguiRoutes` 在 `app.ts:191` 以独立前缀 `/api/agui` 注册，将内部事件翻译为 AG-UI 协议。

## Agent 配置

| 方法 | 路径前缀 | 说明 |
|------|----------|------|
| — | `/api/agent-config` | Agent 配置 CRUD（`routes/agent-config.ts`） |

`AgentConfigService`（`runtime-container.ts:134`）从 `dataRoot` 下的 agent 配置根目录加载团队/角色定义。它会与 `McpService`、`SkillToolService` 双向绑定：

```ts
agentConfig.setMcpService(mcp);       // runtime-container.ts:142
agentConfig.setSkillToolService(skillTools); // runtime-container.ts:182
```

## Team 编排

系统支持 **orchestrator 模式**的动态委派：

- `RuntimeCoreService` 提供 agent 配置与 provider 解析
- `AgentDelegationService` 在运行时把子任务委派给其他 agent
- 委派依赖延迟注入（`runtime-container.ts:248-249`）：

```ts
agentDelegation.setRunEngine(() => agentExecution.runEngine);
agentDelegation.setEventPublisher(() => agentExecution.eventPublisher);
```

## 监控与分析

| 路由文件 | 前缀 | 说明 |
|----------|------|------|
| `monitoring.ts` | `/api/agent` | 运行监控 |
| `analytics.ts` | `/api/agent` | 用量分析（token 趋势/模型用量/活跃热力图） |
| `runtime-core.ts` | `/api/agent` | 运行时核心状态 |

## 持久化与指标

`conversationStore` 实现了 `IMetricStore` 接口，`AgentMetricsCollector`（`runtime-container.ts:221`）复用它：

- 运行结束时指标落库（`AgentRunEngine` 终态写入）
- `/metrics` 端点读取聚合结果

详见 [Agent 运行时架构](/02-architecture/agent-runtime)。

## 会话文件

| 方法 | 路由文件 | 说明 |
|------|----------|------|
| — | `session-files.ts` | 会话级文件附件管理 |

`FileHistoryService`（`runtime-container.ts:114`）记录文件操作历史，供会话文件功能与文档工具复用。
