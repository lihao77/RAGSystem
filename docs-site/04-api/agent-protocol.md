# agent-protocol 协议

`@ragsystem/agent-protocol` 是前后端共享的事件/类型契约包。本章基于 `packages/agent-protocol/src/` 的实际导出。

## 包信息

```json
{
  "name": "@ragsystem/agent-protocol",
  "main": "./dist/index.js",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "dependencies": { "zod": "^3.23.0" }
}
```

::: tip 耦合点
此包被 `backend-ts` 与 `frontend-client` 同时依赖。后端 `contracts/events.ts` **re-export 本包的 Envelope**（后端零重复定义）。任何事件结构变更需：改 protocol → 重建 → 前后端同步更新。
:::

## 模块导出

`src/index.ts` 导出 4 个模块：

| 模块 | 内容 |
|------|------|
| `protocol.ts` | 核心协议：协议版本、Envelope 类型、各 payload 接口 |
| `agent-client.ts` | Agent 客户端 |
| `envelope-delivery.ts` | Envelope 游标、去重和投递辅助 |
| `execution-tree.ts` | 执行树结构 |

## 协议版本

```ts
export const PROTOCOL_VERSION = "1.0" as const;
```

仅 `session.hello` 握手帧必填 `protocol_version` 并锁定连接，其余帧可省略。

## Envelope（线协议信封）

所有实时事件都用统一的 `ProtocolEnvelope`（别名 `Envelope`）封装：

```ts
interface ProtocolEnvelope {
  protocol_version?: ProtocolVersion;  // 仅 session.hello 必填
  type: EnvelopeType;                   // 事件类型
  session_id: string;                   // 会话标识（hello 外必填）
  run_id?: string;                      // 执行单元身份（协议第一公民）
  call_id?: string;                     // 调用/交互关联标识
  agent_id?: string;                    // agent 身份（多 agent/委派区分）
  seq?: number;                         // 本连接内单调递增序号（去重）
  cursor?: number;                      // 持久化事件游标（断线重连回放）
  message_id?: string;
  timestamp?: number | string;
  payload?: unknown;
}
```

## Envelope 类型枚举

`EnvelopeTypeSchema` 定义全部事件类型：

| 类型 | 方向 | 说明 |
|------|------|------|
| `session.hello` | 握手 | 协议握手，锁定 `protocol_version` |
| `heartbeat` | 下行 | 心跳（20s） |
| `session.reconnect` | 下行 | 重连提示 |
| `error` | 下行 | 错误 |
| `run_started` | 下行 | 运行开始 |
| `run_ended` | 下行 | 运行结束 |
| `agent_started` | 下行 | agent 生命周期开始 |
| `agent_ended` | 下行 | agent 生命周期结束 |
| `stream_output` | 下行 | 流式输出 |
| `state_sync` | 下行 | 状态同步 |
| `tool_call` | 下行 | 工具调用 |
| `tool_result` | 下行 | 工具结果 |
| `delegate_call` | 下行 | 委派调用 |
| `delegate_result` | 下行 | 委派结果 |
| `tools.register` | 双向 | 注册工具 |
| `interaction` | 双向 | 交互（审批/用户输入） |
| `user_driven_change` | 上行 | 用户驱动变更 |
| `abort` | 上行 | 中止 |
| `capability_manifest` | 下行 | 能力清单 |
| `ack` | 下行 | 确认 |

## Payload 接口

每种事件类型对应一个 Payload 接口（`protocol.ts`）：

| Payload | 关联类型 | 关键字段 |
|---------|----------|----------|
| `HelloPayload` | `session.hello` | 协议版本、能力 |
| `HeartbeatPayload` | `heartbeat` | — |
| `ReconnectPayload` | `session.reconnect` | cursor |
| `ErrorPayload` | `error` | 错误信息 |
| `AckPayload` | `ack` | 确认的 seq/call_id |
| `RunStartedPayload` | `run_started` | run_id、agent |
| `RunEndedPayload` | `run_ended` | 终态 |
| `AgentLifecyclePayload` | `agent_started/ended` | agent_id |
| `StreamOutputPayload` | `stream_output` | 输出增量 |
| `StateSyncPayload` | `state_sync` | 状态快照 |
| `ToolCallPayload` | `tool_call` | call_id、工具名、参数 |
| `ToolResultPayload` | `tool_result` | call_id、结果 |
| `DelegateCallPayload` | `delegate_call` | 委派目标 |
| `DelegateResultPayload` | `delegate_result` | 委派结果 |
| `ToolsRegisterPayload` | `tools.register` | 工具声明 |
| `InteractionPayload` | `interaction` | 交互详情 |

## 两个独立扩展点

`protocol.ts:70` 注释明确：**两个扩展点互不嵌套、各自带扩展槽**：

1. **ProtocolDescriptor**（`protocol.ts:75`）— 协议描述
2. **CapabilityDescriptor**（`protocol.ts:83`）+ **ToolAllowance**（`protocol.ts:94`）— 能力描述

## 关键类型

```ts
type InteractionKind = "approval" | "user_input";   // 交互种类
type RiskLevel = "low" | "medium" | "high";          // 风险等级（per-tool）
```

`RiskLevel` 与 MCP 工具的 `risk_level` 元数据对应，驱动权限审批策略。

## 与 SDK 的边界

`KernelEvent` 是 `@ragsystem/agent-sdk` 的运行时输出，不属于客户端线协议。backend 的
`services/agent/sdk/event-translation.ts` 同时依赖 SDK 事件和本包的 `Envelope`，将运行时事件投影为客户端可见事件。

依赖方向保持为 backend → SDK + protocol；protocol 不依赖 SDK，也不包含取消、挂起等运行时控制类型。

## 使用方式

### 后端

`backend-ts` 的 `contracts/events.ts` re-export 本包，`DurableClientEventPublisher` 产出 Envelope 写入 outbox，`OutboxDispatcher` 投递到 SSE/WS。

### 前端

`frontend-client` 的 composables（如 `useSessionAgentClient`）消费 Envelope，按 `type` 分发处理。

## 构建

```bash
npm -w @ragsystem/agent-protocol run build     # tsc -p tsconfig.json → dist/
npm -w @ragsystem/agent-protocol run typecheck # --noEmit
```

根 `package.json` 提供 `build:protocol` 与 `typecheck:protocol` 快捷脚本。改源码后需重建才能让前后端看到新类型。
