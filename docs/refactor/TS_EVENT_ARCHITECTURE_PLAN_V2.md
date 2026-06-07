# TS 后端事件架构落地方案 V2

> 创建时间：2026-06-07  
> 修订状态：已补齐评审阻塞项
> 范围：`backend-ts` runtime-core、agent execution、WebSocket realtime、conversation persistence

## 结论

V2 采用 V1 的 Recorder + Outbox + Dispatcher + Projection 方向，但把首期目标收敛到 agent execution 的关键生命周期事件。首个落地切片围绕 `agent-execution-service.ts` L580-L699 的 completed/failed/interrupted 终止路径，不承诺“只改 52 行即可完成”，因为需要配套补齐事务 API、outbox schema、projection、WebSocket replay cursor 和测试护栏。

核心调整：

1. **事务边界先改造**：当前 `ConversationStore.withTransaction` 是 private，不能让 Recorder 直接调用现有 public 写方法形成嵌套事务；先新增受控事务门面。
2. **序列语义分离**：`session_seq/event_seq` 是 durable replay cursor，现有 `stream_seq` 保持 WebSocket transport 序号，不再混用。
3. **事件矩阵补全**：completed 路径必须覆盖 `execution.step`、`output.final_answer`、`call.agent.end`、`output.message_saved`、`run.end`；failed/interrupted 路径必须覆盖 `call.agent.end`、`execution.step`、`agent.error`、`run.end`。
4. **首期 shadow-first**：dispatcher 先做投影比对和可观测，不直接替换 live publish，避免双发或顺序回归。

## 当前代码事实

### 事件发布现状

- `AgentExecutionService` 中存在多处 `eventPublisher.*` 和 `this.events.publish(...)` 调用。
- `AgentExecutionEventPublisher` 同时负责构造 client payload、写 `run_steps`、推送 `InMemoryEventBus`。
- `InMemoryEventBus` 只保留进程内 history，进程重启后无法恢复关键事件。

### completed 路径当前事件顺序

`agent-execution-service.ts` L580-L632 当前顺序：

1. 写 final `execution.step`。
2. 写 run end `execution.step`。
3. 更新 run steps 的 `message_id`。
4. 更新 run status 为 `completed`。
5. 发布 final `execution.step`。
6. 发布 `output.final_answer`。
7. 发布 `call.agent.end`。
8. 发布 run end `execution.step`。
9. 发布 `output.message_saved`。
10. 发布 `run.end`。

V2 projection 必须保持前端可见顺序，不能遗漏 `output.message_saved`。

### failed/interrupted 路径当前事件顺序

`agent-execution-service.ts` L633-L699 当前顺序：

1. 更新 run status 为 `failed` 或 `interrupted`。
2. 发布 `call.agent.end`，`success=false`。
3. 写 run end `execution.step`。
4. 发布 run end `execution.step`。
5. 发布 `agent.error`。
6. 发布 `run.end`。

V2 的 Recorder 输入必须能表达没有 final message 的 terminal state。

### 事务约束

当前 `ConversationStore.withTransaction` 是 private，且 `addMessage`、`addRunStep` 等 public 方法内部会自行开事务。Recorder 不能在一个外层事务里直接调用这些 public 方法，否则会遇到不可访问或 nested transaction 风险。

## 目标

1. 核心状态写入与 outbox 记录在同一 SQLite 事务内完成。
2. 前端 `ClientEvent` 协议保持兼容。
3. 高频流式事件仍 live-only：`output.chunk`、`agent.intent_delta`、`llm.first_token` 首期不进 durable outbox。
4. 重连回放从内存 history 逐步迁移到 durable outbox projection。
5. 每个阶段有明确验收和回退策略。

## 非目标

- 不引入 Kafka、Redis Stream、RabbitMQ 等外部 broker。
- 不做完整 event sourcing。
- 不把所有业务流程改为事件订阅驱动。
- 不在首期持久化 token delta 级别事件。
- 不一次性迁移所有 event publisher 调用点。

## 目标架构

```text
AgentExecutionService
  ├─ 高频流式事件 -> InMemoryEventBus / RealtimeEventHub live-only
  │   └─ output.chunk, agent.intent_delta, llm.first_token
  │
  └─ 关键生命周期事件 -> ExecutionRecorder
      └─ ConversationStore.runInTransaction(tx => {
            写 messages / runs / run_steps
            生成 session_seq
            写 event_outbox
          })

OutboxDispatcher
  └─ fetch pending outbox rows
      -> ClientEventProjector
      -> shadow compare 或 RealtimeEventHub publish
      -> mark delivered / retry / failed

WebSocket
  └─ live subscribe RealtimeEventHub
      + durable replay by event_seq
```

## 数据模型

### event_outbox

```sql
CREATE TABLE IF NOT EXISTS event_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT,
  session_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  locked_at TIMESTAMP,
  delivered_at TIMESTAMP,
  last_error TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_event_outbox_pending
  ON event_outbox(status, available_at, id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_event_outbox_session_seq
  ON event_outbox(session_id, session_seq);

CREATE INDEX IF NOT EXISTS idx_event_outbox_run_seq
  ON event_outbox(run_id, session_seq);
```

字段语义：

- `id`：数据库内全局 delivery cursor，用于 dispatcher 批量扫描。
- `session_seq`：同一 session 内单调递增 durable replay cursor。
- `event_id`：幂等去重 ID，投影到 client event。
- `status`：`pending | processing | delivered | failed`。
- `payload`：DomainEvent JSON，不直接等同前端协议。

### session_event_seq

```sql
CREATE TABLE IF NOT EXISTS session_event_seq (
  session_id TEXT PRIMARY KEY,
  last_seq INTEGER NOT NULL DEFAULT 0,
  FOREIGN KEY(session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
);
```

`getNextSessionSeq(sessionId)` 必须在同一事务内调用：

```sql
INSERT INTO session_event_seq(session_id, last_seq)
VALUES (?, 1)
ON CONFLICT(session_id) DO UPDATE SET last_seq = last_seq + 1
RETURNING last_seq;
```

## 序列和 WebSocket 协议

当前 `ws.ts` 会在发送时递增并覆盖 `stream_seq`。因此 V2 不把 outbox `session_seq` 直接写成 `stream_seq`。

首期规则：

1. `stream_seq` 继续表示单个 WebSocket 连接上的 transport 序号。
2. outbox 投影出的 client event 增加 `event_id` 和 `event_seq`。
3. durable replay 使用 `last_event_seq`，不复用 `last_stream_seq`。
4. heartbeat 保留 `last_stream_seq`，Phase 4 增加 `last_event_seq`。
5. `send()` 可以继续 stamp `stream_seq`，但不得删除已有 `event_id/event_seq`。

示例 client event：

```typescript
{
  type: "run.end",
  session_id: sessionId,
  run_id: runId,
  event_id: "uuid",
  event_seq: 42,
  stream_seq: 17,
  status: "completed",
  final_message_id: messageId
}
```

## ConversationStore 事务策略

### 必须先补齐的 API

新增 public 事务入口，但不暴露裸 `DatabaseSync`：

```typescript
interface ConversationStoreTransaction {
  addMessage(input: AddMessageInput): MessageInfo;
  addRunStep(input: AddRunStepInput): RunStepRecord;
  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number;
  updateRunStatus(runId: string, sessionId: string, status: string, finalMessageId?: string | null): boolean;
  nextSessionSeq(sessionId: string): number;
  appendOutbox(input: AppendOutboxInput): OutboxRow;
}

class ConversationStore {
  runInTransaction<T>(operation: (tx: ConversationStoreTransaction) => T): T;
}
```

实现要求：

- `runInTransaction` 内部复用现有 private `withTransaction`。
- transaction facade 的写方法不能再次开启事务。
- 现有 public `addMessage`、`addRunStep` 等方法保留，通过同一批 private helper 实现。
- Recorder 只使用 `runInTransaction(tx => ...)`，不能在事务内调用现有会自开事务的 public 写方法。

## DomainEvent 首期集合

首期不追求最少类型，而追求和当前前端事件矩阵一一对应，降低顺序和漏事件风险。

```typescript
type DomainEventType =
  | "execution.step_recorded"
  | "message.saved"
  | "run.final_answer_recorded"
  | "agent.call_finished"
  | "run.completed"
  | "run.failed"
  | "run.interrupted";

interface DomainEventBase<T extends DomainEventType, D> {
  event_id: string;
  event_type: T;
  session_id: string;
  run_id: string;
  aggregate_type: "run" | "message" | "agent_call";
  aggregate_id: string;
  session_seq: number;
  timestamp: number;
  data: D;
}
```

一条 outbox row 首期投影为一条 client event。以后如果需要一条 DomainEvent 投影多条 ClientEvent，必须引入 `projection_index` 后再做。

## ExecutionRecorder 接口

Recorder 对外保持少量入口，但 `recordRunTerminal` 使用 discriminated union 区分成功、失败和中断。

```typescript
interface ExecutionRecorder {
  recordStep(input: RecordStepInput): RunStepRecord;
  recordRunTerminal(input: RunCompletedInput | RunFailedInput | RunInterruptedInput): RunTerminalRecord;
}

interface RunCompletedInput {
  status: "completed";
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  agentName: string;
  agentDisplayName: string;
  finalMessage: {
    id?: string;
    content: string;
    metadata: Record<string, unknown>;
  };
  finalStepPayload: Record<string, unknown>;
  runEndStepPayload: Record<string, unknown>;
  finalMetadata: Record<string, unknown>;
}

interface RunFailedInput {
  status: "failed";
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  agentName: string;
  agentDisplayName: string;
  errorMessage: string;
  runEndStepPayload: Record<string, unknown>;
  finalMetadata: Record<string, unknown>;
}

interface RunInterruptedInput extends Omit<RunFailedInput, "status"> {
  status: "interrupted";
}
```

`recordRunTerminal` 事务内职责：

- completed：写 assistant message、final step、run end step、run status、outbox rows。
- failed/interrupted：写 run end step、run status、outbox rows。
- 返回投影所需的 committed result，例如 message id、step ids、event ids。

迁移期职责：

- Phase 2-4 保留旧同步 publish。
- outbox dispatcher 默认 shadow，不向真实 WS 双发。
- Phase 5 再移除关键事件旧同步 publish。

## ClientEvent 投影矩阵

### completed

| 顺序 | DomainEvent | ClientEvent | 说明 |
| --- | --- | --- | --- |
| 1 | `execution.step_recorded` | `execution.step` | final step |
| 2 | `run.final_answer_recorded` | `output.final_answer` | final answer content + metadata |
| 3 | `agent.call_finished` | `call.agent.end` | root agent success |
| 4 | `execution.step_recorded` | `execution.step` | run end step |
| 5 | `message.saved` | `output.message_saved` | 保持当前前端行为 |
| 6 | `run.completed` | `run.end` | final_message_id + metadata |

### failed/interrupted

| 顺序 | DomainEvent | ClientEvent | 说明 |
| --- | --- | --- | --- |
| 1 | `agent.call_finished` | `call.agent.end` | `success=false` |
| 2 | `execution.step_recorded` | `execution.step` | run end step |
| 3 | `run.failed` / `run.interrupted` | `agent.error` | 兼容当前错误事件 |
| 4 | `run.failed` / `run.interrupted` | `run.end` | terminal status |

同一个 `run.failed/run.interrupted` 需要产生两个前端事件时，首期可拆成两条 outbox rows，或引入 `projection_index`。为保持一条 outbox row 对一条 client event，首期推荐拆成 `run.error_reported` 和 `run.failed/run.interrupted` 两个事件；如果不新增类型，则必须在 schema 中记录 projection index。

## OutboxDispatcher

```typescript
class OutboxDispatcher {
  start(): void;
  stop(): void;
  pollOnce(): void;
}
```

策略：

- batch size：100。
- poll interval：500ms。
- pending row 按 `id ASC` 扫描，保证全局处理稳定。
- 同一 session replay 按 `session_seq ASC`。
- 投递失败时 `attempts += 1`，按 backoff 更新 `available_at`。
- 超过最大重试次数后标记 `failed` 并写 `last_error`。

首期运行模式：

- `disabled`：不启动。
- `shadow`：读取 outbox 并投影，与现有 live publish 记录做测试/日志比对，不推送真实客户端。
- `live`：投递到 RealtimeEventHub。

默认必须是 `shadow`，直到 Phase 4 验收通过。

## 实施路线

### Phase 0：测试护栏

目标：锁定当前协议行为，不改 runtime。

工作：

- 为 completed 路径建立事件顺序测试。
- 为 failed 路径建立事件顺序测试。
- 为 interrupted 路径建立事件顺序测试。
- 覆盖 active run replay 当前依赖 `InMemoryEventBus.getHistory()` 的行为。
- 覆盖 `output.message_saved` 不丢失。

验收：

- completed 事件顺序为 `execution.step -> output.final_answer -> call.agent.end -> execution.step -> output.message_saved -> run.end`。
- failed/interrupted 事件顺序为 `call.agent.end -> execution.step -> agent.error -> run.end`。
- 所有现有 TS 测试通过。

回退：

- 无 runtime 改动，无需回退。

### Phase 1：schema 与事务基础设施

目标：新增 outbox 能力，但不接入 agent execution。

工作：

- 在 `conversation-store/schema.ts` 新增 `event_outbox` 和 `session_event_seq`。
- 新增 outbox row 类型和 helper。
- 新增 `ConversationStore.runInTransaction` 和 transaction facade。
- 将 `addMessage`、`addRunStep` 的内部 SQL 抽成不自开事务的 private helper，public 方法行为保持不变。
- 新增 outbox CRUD 单元测试。

验收：

- 事务内写 message/run_step/outbox 任一失败会整体 rollback。
- `session_seq` 在同一 session 内单调递增。
- public store API 行为不变。

回退：

- 删除新增表和未接入 runtime 的代码即可。

### Phase 2：ExecutionRecorder 首个切片双写

目标：收敛 L580-L699 terminal path 的核心状态写入，同时写 outbox，但 live 事件仍走旧路径。

工作：

- 新增 `services/runtime/event-outbox/`。
- 新增 `ExecutionRecorder`。
- completed 路径改为通过 recorder 事务写 assistant message、steps、run status、outbox。
- failed/interrupted 路径改为通过 recorder 事务写 run end step、run status、outbox。
- 旧 `events.publish` 保留，保证前端不变。
- 新增 recorder 单元测试和 agent execution 集成测试。

验收：

- completed/failed/interrupted 三条路径 DB 状态与改造前一致。
- outbox rows 顺序与事件矩阵一致。
- live WebSocket 事件顺序与 Phase 0 基线一致。

回退：

- 切回旧 terminal path；outbox 表可保留但不消费。

### Phase 3：Projection 与 dispatcher shadow

目标：验证 outbox 能稳定投影成当前 ClientEvent，但不向真实客户端双发。

工作：

- 新增 `ClientEventProjector`。
- 新增 `OutboxDispatcher`，默认 shadow。
- shadow 模式记录 projected client event 与 live event 的类型、关键字段、顺序差异。
- 加入 outbox metrics：pending count、oldest pending age、delivered/failed count、projection mismatch count。

验收：

- completed/failed/interrupted 的 projection 与 Phase 0 基线一致。
- dispatcher 重启后能继续处理 pending rows。
- shadow mismatch 为 0 或仅存在已登记的无害字段差异。

回退：

- 关闭 dispatcher；recorder 双写 outbox 仍可保留。

### Phase 4：WebSocket durable replay 与 live 切换

目标：关键 lifecycle client event 可由 outbox dispatcher 驱动，重连回放使用 durable cursor。

工作：

- `ws.ts` 增加 `last_event_seq` 支持。
- heartbeat 增加 `last_event_seq`，保留 `last_stream_seq`。
- replay 优先读取 outbox projection；内存 history 只做 live buffer。
- 通过配置将 completed/failed/interrupted 关键事件从 shadow 切到 live dispatcher。
- 避免旧 publish 与 dispatcher 双发：同一事件类型按 feature flag 二选一。

验收：

- WS live delivery 与 Phase 0 基线一致。
- 进程重启后可按 `event_seq` 回放 terminal lifecycle 事件。
- 前端未升级时仍能依赖 `stream_seq` 接收 live event。

回退：

- 关闭 durable replay 和 dispatcher live flag，回到内存 history + 旧 publish。

### Phase 5：移除首个切片旧同步 publish

目标：terminal lifecycle 关键事件由 outbox dispatcher 主导。

工作：

- 移除 completed/failed/interrupted 终止路径的旧同步关键事件 publish。
- 保留 transport-local event：heartbeat、ack、send.error、stop.ack。
- 保留高频 live-only event：`output.chunk`、`agent.intent_delta`、`llm.first_token`。
- 更新文档和测试，标明 terminal events 的事实来源是 outbox。

验收：

- terminal path 没有重复 client event。
- outbox pending/failed 可观测。
- 模拟 dispatcher 暂停后，恢复时能补发关键事件。

回退：

- 恢复旧 publish flag，dispatcher 改回 shadow。

实现状态：

- 已实现 `BACKEND_TS_TERMINAL_EVENT_DELIVERY=outbox_live|sync`。
- 默认 `outbox_live`：completed/failed/interrupted terminal events 由 outbox projection 派发，旧同步 publish 不再双发。
- `sync` 回退：terminal events 仍走旧同步 publish，同时保留 outbox 记录用于诊断/后续 replay。
- `/api/agent/metrics` 已暴露 `event_outbox` delivery mode、dispatcher metrics 和 pending/delivered/failed 统计。

## 测试计划

### Unit

- `ConversationStore.runInTransaction` rollback。
- `session_event_seq` 单调递增。
- `appendOutbox/fetchPending/markDelivered/markFailed`。
- `ExecutionRecorder.recordRunTerminal` completed/failed/interrupted。
- `ClientEventProjector` 覆盖全部首期 DomainEvent。

### Integration

- agent stream completed：message、run_steps、run status、outbox、WS event 顺序。
- agent stream failed：run status、run end step、agent.error、run.end。
- agent stream interrupted：status interrupted、agent.error error_type、run.end。
- dispatcher restart：pending rows 能继续处理。
- WS reconnect：`last_event_seq` 回放 terminal events。

### Regression

- `output.message_saved` 不丢失。
- `stream_seq` 仍由 WS transport 生成。
- `event_seq` 不被 WS send 覆盖。
- 高频 events 不进入 outbox。

## 风险和处理

| 风险 | 处理 |
| --- | --- |
| 嵌套事务 | 先做 transaction facade，Recorder 禁止调用会自开事务的 public 写方法 |
| 双发事件 | dispatcher 先 shadow；live 切换时按 feature flag 二选一 |
| 顺序回归 | 首期一条 outbox row 对一条 client event，按 `session_seq` 排序 |
| 重连 cursor 混乱 | `stream_seq` 和 `event_seq` 分离，Phase 4 引入 `last_event_seq` |
| 高频事件压垮 DB | `output.chunk`、`agent.intent_delta`、`llm.first_token` live-only |
| 失败事件漏投影 | failed/interrupted 单独事件矩阵和测试 |

## 成功标准

- completed/failed/interrupted 关键事件具备 durable outbox。
- 核心状态写入和 outbox 写入具备同事务保证。
- WebSocket live 协议兼容现状。
- durable replay 不依赖进程内 history。
- 事件调用点在 terminal path 明显收敛。
- dispatcher 状态可观测、可暂停、可恢复。
