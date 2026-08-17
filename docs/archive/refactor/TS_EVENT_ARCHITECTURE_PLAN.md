# TS 后端事件架构落地方案

> 创建时间：2026-06-07  
> 状态：方案待实施  
> 范围：`backend-ts` runtime-core、agent execution、WebSocket realtime、conversation persistence

## 背景

当前 TS 后端已经具备可工作的事件机制，但它主要服务于 WebSocket 实时推送：

- `InMemoryEventBus` 按 `sessionId` 发布和订阅事件，并保留进程内短期 history。
- `ws.ts` 是生产代码中主要订阅方，负责把 session 事件推给前端，并在运行中重连时回放部分 history。
- `AgentExecutionService`、`AgentExecutionEventPublisher`、`PendingInteractionService`、`BackgroundTaskService`、`AgentDelegationService` 等服务会发布事件。
- 核心持久化不是通过事件订阅完成，而是业务服务直接写 `ConversationStore`、`CheckpointManager`、文件 store 等。

这个设计适合作为 v1：实现简单、调用链清晰、前端实时体验可用。它的主要缺口是可靠事件派发和调用点收敛：事件只在内存中，进程崩溃后不可恢复；写库和发事件分散在多个服务里；`DomainEvent` 和前端 `ClientEvent` 没有边界。

## 目标

目标不是把 TS 后端改成纯 event sourcing，也不是让内存 event bus 承担持久化事实来源。

目标架构是：

1. 核心业务状态仍由 domain service 直接持久化。
2. 写核心状态和记录待派发事件在同一事务中完成。
3. 事件通过 durable outbox 派发给 WebSocket、metrics、audit、notification 等消费者。
4. 后端 domain event 与前端 client event 分离，前端协议通过 projection 生成。
5. 现有 WebSocket 行为保持兼容，迁移期间不破坏当前前端。

## 非目标

- 不引入 Kafka、Redis Stream、RabbitMQ 等外部 broker 作为首期依赖。
- 不把所有业务流程都改成事件订阅驱动。
- 不把 `InMemoryEventBus` 升级成数据库事实来源。
- 不改变已有 session/message/run/run_steps 的语义。
- 不为了架构一致性重写 agent execution 主流程。

## 当前事件关系

### 事件合约

- `backend-ts/src/contracts/events.ts`
  - `ClientEvent`
  - `ClientEventTypeSchema`
  - `ClientToServerMessageSchema`

当前合约偏前端协议，事件类型包括：

- lifecycle：`session.run_started`、`run.start`、`run.end`、`session.updated`
- execution：`execution.step`、`context.usage`、`context.compression_start`、`context.compression_summary`
- agent：`agent.start`、`agent.end`、`agent.error`、`agent.intent_delta`、`agent.intent_complete`
- call：`call.agent.start`、`call.agent.end`
- output：`llm.first_token`、`output.chunk`、`output.final_answer`、`output.message_saved`
- interaction：`interaction.required`、`user.approval_required`、`user.approval_granted`、`user.approval_denied`、`user.input_required`
- transport：`heartbeat`、`reconnect_start`、`reconnect_end`、`send.ack`、`stop.ack`、error/ack variants

### 发布方

- `AgentExecutionEventPublisher`
  - 运行开始、agent/call 开始结束、runtime streaming、tool call/result、context compression、execution step。
- `AgentExecutionService`
  - context usage、final answer、run end、agent error、stop/interrupted 相关事件。
- `PendingInteractionService`
  - 审批和用户输入请求。
- `BackgroundTaskService`
  - 后台任务完成事件。
- `AgentDelegationService`
  - 子 agent call start/end。

### 订阅方

- `routes/agent/ws.ts`
  - 订阅 `container.events.subscribe(sessionId, handler)`。
  - 将事件发送给 WebSocket 客户端。
  - 使用 `container.events.getHistory(sessionId)` 做运行中重连回放。

目前没有生产代码中的后端业务订阅者负责核心状态变更。

### 持久化路径

- `ConversationStore`
  - sessions、messages、runs、run_steps、resources、child_agents。
- `CheckpointManager`
  - checkpoint。
- `FileIndexService`
  - uploaded file index。
- `MemoryStore`
  - memory markdown files。
- `AgentConfigService` / `ModelAdapterService`
  - config YAML。
- `ArtifactService` / background output
  - file artifacts。

## 目标架构

```text
Domain Service
  -> ExecutionRecorder / DomainRecorder
      -> ConversationStore transaction
      -> EventOutbox append in same transaction
  -> returns committed domain result

OutboxDispatcher
  -> loads pending outbox rows
  -> projects DomainEvent to ClientEvent/SystemEvent
  -> delivers to RealtimeEventHub / Metrics / Audit / Notifications

RealtimeEventHub
  -> in-memory session subscribers
  -> WebSocket transport
  -> short live replay cache
```

### 分层职责

#### 1. Domain Service

负责业务决策和核心状态变更。

示例：

- 创建 run。
- 保存 user message。
- 保存 assistant final message。
- 写入 execution step。
- 更新 run status。
- 创建 interaction request。
- 完成/取消后台任务。

Domain Service 不直接关心 WebSocket。

#### 2. Recorder

新增统一记录门面，收敛“写 store + 生成事件”的重复逻辑。

建议命名：

- `ExecutionRecorder`
- `InteractionRecorder`
- `BackgroundTaskRecorder`

首期可以先只做 `ExecutionRecorder`，因为 execution 是事件最多、分散度最高的区域。

建议接口：

```ts
interface ExecutionRecorder {
  recordRunStarted(input: RunStartedInput): void;
  recordRunStep(input: RunStepInput): RunStepRecord;
  recordMessageSaved(input: MessageSavedInput): MessageInfo;
  recordFinalAnswer(input: FinalAnswerInput): MessageInfo;
  recordRunEnded(input: RunEndedInput): void;
  recordAgentError(input: AgentErrorInput): void;
}
```

Recorder 内部负责：

- 写 `ConversationStore`。
- 构造 `DomainEvent`。
- 写 `event_outbox`。
- 对迁移期仍需要即时发送的事件，同步转发给现有 `InMemoryEventBus`。

#### 3. Event Outbox

新增 SQLite 表 `event_outbox`。

建议 schema：

```sql
CREATE TABLE IF NOT EXISTS event_outbox (
  event_id TEXT PRIMARY KEY,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  session_id TEXT,
  run_id TEXT,
  event_type TEXT NOT NULL,
  event_version INTEGER NOT NULL DEFAULT 1,
  payload TEXT NOT NULL,
  client_visible INTEGER NOT NULL DEFAULT 1,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_pending
  ON event_outbox(status, available_at, sequence);

CREATE INDEX IF NOT EXISTS idx_event_outbox_session_sequence
  ON event_outbox(session_id, sequence);

CREATE INDEX IF NOT EXISTS idx_event_outbox_run_sequence
  ON event_outbox(run_id, sequence);
```

`sequence` 推荐由数据库单调生成。SQLite 可以先使用 `INTEGER PRIMARY KEY AUTOINCREMENT` 的内部 id 作为排序依据，或维护单独 sequence 字段。重点是不依赖 `Date.now()` 排序。

#### 4. Dispatcher

新增 `OutboxDispatcher`，从 `event_outbox` 拉取 pending 事件并派发。

职责：

- 批量读取 pending rows。
- 投影 `DomainEvent` 到 `ClientEvent`。
- 投递到 realtime hub。
- 可选投递 metrics/audit/notification。
- 成功后标记 delivered。
- 失败后增加 attempts，设置下一次 `available_at`。

首期可以进程内轮询，不引入外部 broker。

建议策略：

- batch size：100。
- poll interval：100-500ms。
- retry backoff：1s、5s、30s、2m。
- 最大 attempts 后标记 `failed`，保留诊断。

#### 5. Projection

新增 `ClientEventProjector`，避免 domain service 直接构造前端协议。

示例：

```ts
type DomainEvent =
  | RunStartedEvent
  | RunStepRecordedEvent
  | MessageSavedEvent
  | FinalAnswerRecordedEvent
  | RunEndedEvent
  | InteractionRequestedEvent;

interface ClientEventProjector {
  toClientEvents(event: DomainEvent): ClientEvent[];
}
```

一条 domain event 可以产生多条 client event。例如 `FinalAnswerRecorded` 可以投影为：

- `execution.step`
- `output.final_answer`
- `output.message_saved`
- `run.end`

具体是否合并，需要按前端现有行为保持兼容。

#### 6. Realtime Event Hub

现有 `InMemoryEventBus` 可以演进为 `RealtimeEventHub`。

职责限定为：

- 管理 session 订阅者。
- 将已经投影好的 `ClientEvent` 推给 WebSocket。
- 保留短期 live replay cache。

它不负责：

- 核心持久化。
- outbox 状态。
- 业务副作用。
- 长期事件审计。

## 事件分类

### DomainEvent

系统事实，供 outbox 和内部消费者使用。

建议首批：

- `RunCreated`
- `RunStarted`
- `RunStepRecorded`
- `MessageSaved`
- `FinalAnswerRecorded`
- `RunCompleted`
- `RunFailed`
- `RunInterrupted`
- `InteractionRequested`
- `InteractionResolved`
- `BackgroundTaskCompleted`
- `AgentCallStarted`
- `AgentCallCompleted`

### ClientEvent

前端协议，保持当前 `ClientEvent` 兼容。

示例：

- `execution.step`
- `output.chunk`
- `output.final_answer`
- `output.message_saved`
- `interaction.required`
- `run.end`

### SystemEvent

内部横切能力。

示例：

- metrics sample
- audit log
- notification trigger
- diagnostics

### TransportEvent

WebSocket 或未来 SSE/HTTP stream 自身事件。

示例：

- `heartbeat`
- `reconnect_start`
- `reconnect_end`
- `send.ack`
- `stop.ack`

TransportEvent 不进入 domain outbox。

## 迁移路线

### Phase 0：梳理和测试护栏

目标：不改行为，先建立基线。

工作：

- 为当前 event publish 点建立清单测试或快照测试。
- 覆盖 WebSocket live delivery。
- 覆盖 active run replay。
- 覆盖 final answer、run end、execution step 顺序。
- 覆盖 interaction required 与 approval/user input ack。

验收：

- 当前 WebSocket 协议行为有测试保护。
- 迁移后可以确认没有破坏前端依赖。

### Phase 1：新增 Recorder，收敛调用点

目标：仍使用现有 `InMemoryEventBus`，但把分散的“写库 + 发事件”收敛。

工作：

- 新增 `ExecutionRecorder`。
- 把 `AgentExecutionEventPublisher.addExecutionStep()` 迁入 recorder。
- 把 final answer 保存、run status 更新、run end 事件生成迁入 recorder。
- 保持对现有 `events.publish()` 的同步调用，前端行为不变。

验收：

- `AgentExecutionService` 中直接 `events.publish()` 的数量明显下降。
- execution step 持久化和事件发布集中在 recorder。
- 所有现有 TS 测试通过。

### Phase 2：新增 Outbox，只写不派发

目标：建立 durable event 记录，但不改变 runtime 行为。

工作：

- `ConversationStore` 增加 `event_outbox` schema。
- 新增 `EventOutboxStore`。
- Recorder 在写核心状态时同步 append outbox。
- outbox row 先只用于诊断和测试，不驱动 WebSocket。

验收：

- 每个关键 domain action 都产生 outbox row。
- outbox 写入和核心状态写入在同一事务边界内。
- outbox payload 可通过测试验证。

### Phase 3：Dispatcher 并行派发

目标：让 dispatcher 可以读取 outbox 并投递到 realtime hub，但仍保留旧 publish 作为 fallback。

工作：

- 新增 `OutboxDispatcher`。
- 新增 `ClientEventProjector`。
- dispatcher 投递到现有 `InMemoryEventBus` 或新 `RealtimeEventHub`。
- 增加 delivery status、retry、failed 状态。
- 通过配置开关启用。

验收：

- 开启 dispatcher 后 WebSocket 能收到 outbox 投影事件。
- 关闭 dispatcher 后旧同步 publish 仍可工作。
- dispatcher 重启后能继续处理 pending rows。

### Phase 4：切换 WebSocket 到 durable replay

目标：重连回放不再只依赖内存 history。

工作：

- `ws.ts` active replay 改为优先读取 outbox/client event projection。
- 内存 history 只作为实时缓冲，不作为唯一回放来源。
- 支持按 `last_stream_seq` 或 client ack 点回放。

验收：

- 进程重启后，运行历史可从数据库恢复一部分必要 client events。
- WebSocket 重连不会重复关键 final/run end 事件。
- 前端无需大改。

### Phase 5：移除旧同步 publish 依赖

目标：事件派发由 outbox dispatcher 主导。

工作：

- recorder 不再直接 publish 关键 client event，改为只写 outbox。
- 只保留少数 transport-local 事件直接发送，例如 heartbeat、ack。
- `InMemoryEventBus` 重命名或替换为 `RealtimeEventHub`。

验收：

- 核心 client events 均来自 outbox dispatcher。
- 内存 bus 不再承担业务事件事实来源。
- 事件丢失风险可通过 pending outbox 诊断和恢复。

## 一致性规则

- 核心状态写入成功但 outbox 写入失败：整个事务失败。
- outbox 写入成功但 dispatcher 失败：业务状态已提交，事件稍后重试。
- dispatcher 投递必须幂等。
- client event 必须带稳定 `event_id` 或 `sequence`，便于去重。
- 同一 session/run 的关键事件必须保持 sequence 顺序。
- `output.chunk` 这类高频流式事件可以按策略不进入 durable outbox，或进入独立轻量 stream buffer；首期应保持现状，不强行持久化所有 token delta。

## 高频事件策略

不是所有事件都应该 durable。

建议分类：

| 类型 | 是否写 outbox | 说明 |
| --- | --- | --- |
| `RunStarted` | 是 | 关键生命周期 |
| `RunStepRecorded` | 是 | 已对应 run_steps，适合持久化 |
| `MessageSaved` | 是 | 关键 UI 状态 |
| `FinalAnswerRecorded` | 是 | 关键结果 |
| `RunEnded` | 是 | 关键生命周期 |
| `InteractionRequested` | 是 | 用户动作必须可恢复 |
| `BackgroundTaskCompleted` | 是 | 可能影响后续上下文 |
| `output.chunk` | 否，首期保持 live-only | 高频 token delta，已有 final answer 兜底 |
| `agent.intent_delta` | 否，首期保持 live-only | 高频中间态 |
| `heartbeat` | 否 | transport-local |
| `send.ack` / `stop.ack` | 否 | transport-local |

## 测试计划

### Unit Tests

- `ExecutionRecorder`
  - 写 run step 后产生 outbox。
  - 写 final answer 后更新 message/run/run_steps 并产生事件。
  - error/interrupted 状态产生正确 domain event。
- `EventOutboxStore`
  - append、list pending、mark delivered、mark failed、retry backoff。
  - sequence 顺序稳定。
- `ClientEventProjector`
  - domain event 到 client event 的兼容映射。

### Integration Tests

- agent stream 正常完成：
  - user message persisted。
  - assistant final persisted。
  - run_steps persisted。
  - outbox rows persisted。
  - WebSocket 收到兼容事件。
- agent stream 中断：
  - run status interrupted。
  - outbox 有 interrupted/run.end。
  - WebSocket 收到 `agent.error` 或兼容终止事件。
- interaction：
  - request_user_input / approval request 进入 outbox。
  - WebSocket 重连可恢复 pending interaction。

### Replay Tests

- 进程内重连：兼容现有行为。
- 模拟 dispatcher 重启：pending outbox 可继续派发。
- 模拟 WebSocket 重连：按 session/run sequence 回放。

## 风险和处理

### 风险：事件重复

处理：

- 每个 outbox row 有稳定 `event_id`。
- WebSocket client event 带 `stream_seq` 和 `event_id`。
- 前端可按 `event_id` 去重。

### 风险：事件顺序变化

处理：

- 同一 session/run 使用单调 sequence。
- dispatcher 按 sequence 派发。
- 关键事件不做 priority 插队。

### 风险：高频事件拖慢数据库

处理：

- `output.chunk` 和 `agent.intent_delta` 首期不进 durable outbox。
- 对 final answer、run step、message 等低频关键事件做 outbox。

### 风险：迁移破坏前端协议

处理：

- projection 保持当前 `ClientEvent` shape。
- 迁移期保留旧同步 publish fallback。
- 先加测试，再切换数据来源。

### 风险：事务边界不清晰

处理：

- 首期只让 recorder 处理已有明确写库动作。
- 不把所有 service 一次性迁入。
- 对 final answer 和 run end 这类关键路径优先收敛。

## 建议实施顺序

1. 新增当前事件关系测试和 WebSocket 顺序测试。
2. 新增 `ExecutionRecorder`，收敛 execution step/final/run end。
3. 新增 `event_outbox` schema 和 `EventOutboxStore`。
4. Recorder 写 outbox，但继续同步 publish。
5. 新增 `ClientEventProjector`。
6. 新增 `OutboxDispatcher`，通过开关启用。
7. WebSocket replay 优先使用 durable event source。
8. 移除关键事件的旧同步 publish fallback。

## 成功标准

- 关键业务状态仍由 store 直接持久化，调用链清晰。
- 关键事件不会因为进程崩溃永久丢失。
- WebSocket 仍保持现有前端兼容协议。
- 事件发布调用点明显收敛。
- 后续新增 metrics/audit/notification 不需要侵入 agent execution 主流程。
- 可以通过 outbox 表诊断事件是否已生成、是否已派发、失败原因和重试次数。

