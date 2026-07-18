# Agent 运行时

本章拆解 Agent 执行的内部机制。基于 `backend-ts/src/services/agent/`、`services/runtime/` 与 `runtime-container.ts` 的真实实现。

## 核心组件

| 组件 | 文件 | 职责 |
|------|------|------|
| 执行服务 | `services/agent/execution/` | run-engine、事件发布、启动器、状态追踪 |
| 运行时核心 | `agent/execution/runtime-core-service.ts` | agent 配置 + provider 解析 |
| 委派 | `agent/delegation/` | orchestrator 动态委派子 agent |
| 上下文 | `agent/context/` | context-builder + provider-cache-tracker |
| 上下文压缩 | `agent/context-compression/` | 超长上下文滚动压缩 |
| 记忆 | `agent/memory/` | 记忆系统 |
| 指标 | `agent/metrics/` | 性能采集 |
| prompt | `agent/prompt-builder/` | prompt 组装 |
| SDK 适配 | `agent/sdk/` | runtime-adapter + event-persister + gate-hook + projection |
| 配置 | `agent/config/` | team-store + yaml |

## 执行引擎（run-engine）

`services/agent/execution/run-engine.ts` 是核心，入口方法 `executeRun`：

```ts
async executeRun(input: { ... })
```

由 `createAgentExecutionService`（`runtime-container.ts:222`）装配，返回的 `agentExecution` 暴露：

- `runEngine` — 执行引擎实例
- `eventPublisher` — 事件发布器

### execution 目录文件

| 文件 | 职责 |
|------|------|
| `run-engine.ts` | 执行引擎主循环 |
| `event-publisher.ts` | 事件发布 |
| `launchers.ts` | 执行启动器 |
| `slash-command-handler.ts` | 斜杠命令处理 |
| `status-tracker.ts` | 状态追踪 |
| `readiness.ts` | 就绪检测 |
| `runtime-core-service.ts` | 运行时核心服务 |
| `session-control.ts` | 会话控制 |
| `attachment-resolver.ts` | 附件解析 |
| `query.ts` | 查询 |
| `helpers.ts` | 辅助函数 |

## 工具循环

run-engine 驱动 LLM 与工具的循环：

```
组装上下文 (context-builder)
    │
    ▼
调用 LLM (agent-llm, via provider)
    │
    ▼
解析工具调用 ──┐
    │         │
    │ 权限审批 (PermissionPolicyService)
    │         │
    ▼         │
执行工具 (createBackendTools 聚合的工具集)
    │         │
    │  委派?──┤ AgentDelegationService → 子 agent run-engine
    │         │
    ▼         │
观察结果回填上下文 ──┘
    │
    ▼
（循环直到 LLM 无工具调用 / 终止）
```

工具集由 `createBackendTools`（`tools/registry.ts`）per-agent 聚合，可见性由各工厂按 agent 配置决定。详见 [工具系统](./tool-system)。

## 委派（Delegation）

`AgentDelegationService`（`runtime-container.ts:200`）实现 orchestrator 模式的动态委派：

- 子任务可委派给 Team 内其他 agent
- 委派的 `runEngine` 与 `eventPublisher` 延迟注入（`runtime-container.ts:248-249`）：

```ts
agentDelegation.setRunEngine(() => agentExecution.runEngine);
agentDelegation.setEventPublisher(() => agentExecution.eventPublisher);
```

这样设计是因为 `agentDelegation` 需先实例化（工具依赖它），但其执行依赖尚未创建的 `agentExecution`。

## 上下文压缩

`AgentCompressionService`（`runtime-container.ts:241`）：

- 复用 `conversationStore` 与 `() => modelAdapter.listProviders()`
- 读取 `systemConfig` 的压缩配置
- 在上下文超长时滚动压缩历史，保留关键信息

## 事件投递（Durable Outbox）

终端事件通过**持久化 outbox** 模式投递，保证可靠性：

```
run-engine 产出事件
    │
    ▼
DurableClientEventPublisher (client-event-publisher.ts)
    │  写入 conversationStore（持久化）
    ▼
OutboxDispatcher (dispatcher.ts)  ── 周期轮询
    │
    ▼
RealtimeEventHub (realtime-event-hub.ts)
    │
    ▼
SSE / WebSocket 推送前端
```

### event-outbox 目录

| 文件 | 职责 |
|------|------|
| `client-event-publisher.ts` | 持久化事件发布器（`DurableClientEventPublisher`） |
| `dispatcher.ts` | outbox 分发器（周期轮询，`OutboxDispatcher`） |
| `projector.ts` | 事件投影 |

`OutboxDispatcher` 在容器创建时启动（`runtime-container.ts:127-128`），间隔可配（`outboxDispatcherIntervalMs`）。widget token 的周期清理也跟随其生命周期（`widgetCredentialStore?.startPruning()`）。

## 指标采集

`AgentMetricsCollector`（`runtime-container.ts:221`）：

- 复用 `conversationStore` 的 `metricOps`（`IMetricStore`）
- `AgentRunEngine` 终态落库
- `/metrics` 端点读取聚合结果

## SDK 适配层

`services/agent/sdk/` 将 `@ragsystem/agent-sdk` 内核适配到 backend-ts 运行时：

| 文件 | 职责 |
|------|------|
| `runtime-adapter.ts` | 运行时适配 |
| `event-persister.ts` | 事件持久化 |
| `gate-hook.ts` | 门控钩子 |
| `projection.ts` | 投影 |

容器支持透传 `hooks` 回调（`runtime-container.ts` 的 `hooks` 选项），让 backend 注册 `tool.before/after`、`round.before` 等 handler 到 SDK 的 `HookRegistry`。

## Agent 配置

`AgentConfigService`（`runtime-container.ts:134`）：

- 从 `dataRoot` 下的 agent 配置根目录加载 team/角色定义
- 双向绑定：
  ```ts
  agentConfig.setMcpService(mcp);             // 让配置感知 MCP 工具
  agentConfig.setSkillToolService(skillTools); // 让配置感知技能工具
  ```

## 性能与监控

相关服务：

- `AgentMetricsCollector` — 指标聚合
- `analytics.ts` 路由 — 用量分析（token 趋势/模型用量/活跃热力图/每日活跃度）
- `monitoring.ts` 路由 — 运行监控
