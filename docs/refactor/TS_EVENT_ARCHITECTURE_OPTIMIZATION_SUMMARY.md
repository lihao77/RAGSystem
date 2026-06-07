# TS 后端事件架构方案优化总结

> 时间：2026-06-07  
> 文档版本：V2 修订版

## 背景

V1 方案已经定义了 Recorder、durable outbox、Dispatcher、Projection 和 Realtime hub 的总体方向。初版 V2 试图压缩首期范围，但评审发现它遗漏了事务 API、WebSocket 序列语义、失败路径、`output.message_saved` 和 Phase 2-5 细节。

本总结记录修订后的 V2 与 V1 的实际差异。

## 核心优化

| 维度 | V1 | 修订后 V2 |
| --- | --- | --- |
| 落地范围 | 偏完整架构迁移 | 首期聚焦 agent execution terminal path |
| 事务边界 | 描述方向，未落到当前代码约束 | 明确新增 `runInTransaction(tx => ...)` 和 transaction facade |
| 序列策略 | 提到 sequence，但未区分 transport/replay | `event_seq` 用于 durable replay，`stream_seq` 保持 WS transport 序号 |
| 高频事件 | 说明存在 DB 压力风险 | 明确 `output.chunk`、`agent.intent_delta`、`llm.first_token` live-only |
| 事件投影 | 偏概念性 | 补齐 completed/failed/interrupted 的 client event 矩阵 |
| 迁移策略 | 分阶段方向清晰 | 增加 shadow dispatcher、feature flag、验收和回退 |
| 风险控制 | 主要是原则 | 明确 nested transaction、双发、cursor 混乱等具体风险 |

## 关键技术决策

### 1. 事务 facade 优先于直接暴露 `withTransaction`

当前 `ConversationStore.withTransaction` 是 private，且 public 写方法会自行开事务。修订后 V2 要求新增受控事务入口：

```typescript
class ConversationStore {
  runInTransaction<T>(operation: (tx: ConversationStoreTransaction) => T): T;
}
```

Recorder 只使用 transaction facade，不在事务内调用会再次开事务的 public 写方法。

### 2. `event_seq` 与 `stream_seq` 分离

现有 WebSocket 会在发送时 stamp `stream_seq`。如果把 durable `session_seq` 直接映射成 `stream_seq`，会被覆盖并破坏重连去重语义。

修订后：

- `stream_seq`：单个 WS 连接上的 transport 序号。
- `event_seq`：同一 session 内 durable replay cursor。
- `event_id`：幂等去重 ID。

### 3. 首期事件矩阵按现有协议对齐

completed 路径必须保留：

```text
execution.step -> output.final_answer -> call.agent.end -> execution.step -> output.message_saved -> run.end
```

failed/interrupted 路径必须保留：

```text
call.agent.end -> execution.step -> agent.error -> run.end
```

### 4. Dispatcher 先 shadow 后 live

为避免双发和顺序回归，dispatcher 初始模式是 `shadow`：读取 outbox、投影 client event、和当前 live publish 做差异比对，但不推送真实客户端。只有 shadow 验收通过后，才通过 feature flag 切换到 live。

## 实施路线

| Phase | 核心目标 | 关键验收 |
| --- | --- | --- |
| Phase 0 | 测试护栏 | completed/failed/interrupted 事件顺序有回归测试 |
| Phase 1 | schema 与事务基础设施 | outbox 与核心状态同事务 rollback |
| Phase 2 | Recorder terminal path 双写 | DB 状态不变，outbox 顺序符合事件矩阵 |
| Phase 3 | Projection + dispatcher shadow | projection 与 live 基线无未登记差异 |
| Phase 4 | durable replay + live 切换 | `last_event_seq` 可回放 terminal events |
| Phase 5 | 移除旧同步 publish | terminal events 由 outbox dispatcher 主导且不重复 |

## 对 V1 的保留

修订后 V2 保留 V1 的核心架构判断：

- 不做纯 event sourcing。
- 不引入外部 broker。
- 核心业务状态仍由 store 直接持久化。
- DomainEvent 与 ClientEvent 分离。
- 高频 token delta 不强制 durable。

## 修订后的结论

V2 相比 V1 的价值不是“只改少量代码”，而是给出更贴近当前代码约束的首期切片和迁移顺序。实施时应以 V2 为基线，但必须从 Phase 0 和 Phase 1 开始，不能直接跳到 dispatcher live 或移除旧 publish。
