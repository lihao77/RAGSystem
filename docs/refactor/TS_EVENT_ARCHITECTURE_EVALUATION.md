# TS 后端事件架构方案评估

> 评估时间：2026-06-07
> 评估对象：`TS_EVENT_ARCHITECTURE_PLAN.md` 与修订后的 `TS_EVENT_ARCHITECTURE_PLAN_V2.md`

## 评估结论

V1 方向总体正确：Recorder + durable outbox + Dispatcher + Projection 是解决 TS 后端事件可靠性和调用点分散问题的合适路径。V2 在评审后修订为更可执行的实施基线，关键变化是补齐事务边界、WebSocket 序列语义、失败/中断路径、事件投影矩阵和完整 Phase 2-5 迁移步骤。

当前建议：采用 V2 作为实施基线，但从 Phase 0/1 开始，不跳过测试护栏和事务基础设施改造。

## 当前代码事实

### 调用点分散

- `AgentExecutionService.ts` 包含多处 `eventPublisher.*` 调用和直接 `this.events.publish(...)`。
- `AgentExecutionEventPublisher.ts` 同时负责构造前端事件、写 `run_steps`、推送内存 event bus。
- `InMemoryEventBus` 只保留进程内 history，进程重启后无法恢复关键 lifecycle event。

### 关键终止路径

completed 路径当前不只是 4 个事件，还包含 `output.message_saved`。必须保持顺序：

```text
execution.step -> output.final_answer -> call.agent.end -> execution.step -> output.message_saved -> run.end
```

failed/interrupted 路径没有 final message，当前顺序是：

```text
call.agent.end -> execution.step -> agent.error -> run.end
```

因此 Recorder 接口不能只建模成功路径，也不能强制要求 `finalMessage`。

### 事务约束

`ConversationStore.withTransaction` 当前是 private，且 `addMessage`、`addRunStep` 等 public 方法内部会自行开事务。Recorder 如果直接复用这些 public 方法，会遇到无法访问事务入口或 nested transaction 风险。

### WebSocket 序列约束

`ws.ts` 当前发送时会递增并覆盖 `stream_seq`。因此 durable outbox 的 `session_seq` 不能直接映射为 `stream_seq`。修订后的 V2 把 durable cursor 定义为 `event_seq`，保留 `stream_seq` 作为单连接 transport 序号。

## V2 修订点

| 问题 | 原 V2 风险 | 修订后策略 |
| --- | --- | --- |
| 文档不完整 | Phase 2-5 缺失，自引用“完整文档” | 补全 Phase 0-5 的目标、工作、验收和回退 |
| 事务 API | 直接复用 private `withTransaction` 不可落地 | 新增 `runInTransaction(tx => ...)` 和 transaction facade |
| 序列语义 | `session_seq` 写入 `stream_seq` 会被 WS 覆盖 | 分离 `event_seq` 和 `stream_seq` |
| 成功路径漏事件 | 未覆盖 `output.message_saved` | completed 事件矩阵补齐 6 个 client events |
| 失败路径建模不足 | `recordRunEnd` 强制 `finalMessage` | `recordRunTerminal` 使用 completed/failed/interrupted union |
| 双发风险 | dispatcher 直接 live 可能重复推送 | dispatcher 先 shadow，live 切换用 feature flag 二选一 |

## 实施建议

1. 先执行 Phase 0：为 completed/failed/interrupted 的 WebSocket 事件顺序建立回归测试。
2. 再执行 Phase 1：新增 outbox schema、`session_event_seq`、事务 facade，并验证 rollback。
3. Phase 2 只迁移 terminal path，不迁移所有 event publisher 调用点。
4. Phase 3 dispatcher 必须先 shadow compare，不能直接替换 live publish。
5. Phase 4 才引入 durable replay 的 `last_event_seq`，并保持旧前端可继续使用 `stream_seq`。

## 最终结论

修订后的 V2 可以作为实施基线。它不再依赖“首批只改 52 行”的乐观假设，而是承认首个切片需要配套 store、outbox、projection、WS cursor 和测试改造。这个范围更真实，也更适合降低事件架构迁移风险。
