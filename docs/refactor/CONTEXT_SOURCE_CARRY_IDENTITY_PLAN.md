# Context Source 携带式来源身份方案（消除 conversation/originals 平行数组）

> 创建时间：2026-09-01
> 状态：方案记录，未进入代码实施。短期缓解（对齐占位 + 出口丢重复）与中间方案（refresh 子集投递）已实施——见文末"当前状态"。
> 范围：`backend-core/src/services/agent/context/`（RecentMessagesContextSource / AgentContextBuilder / types）及全部 rawMessages 消费者（runtime-adapter refresh、monitoring 调试快照、extensions 投影）。

## 背景：2026-08-31 重复 tool 应答事故（OpenAI 兼容协议 400）

`RecentMessagesContextSource.build()` 返回两个**靠约定保持逐条索引对齐**的数组：

```
conversation: ChatMessage[]          ← 发给模型的会话视图
originals:    (MessageInfo | null)[] ← 对应原始消息行（refresh 识别投递物、调试快照回绑元数据）
```

对齐是隐式契约：`messagesToConversation` 构建时同步 push，`closeOrphanedToolCalls` 补合成 tool 结果时（修复前）只插 conversation 不插 originals，从插入点起错位。runtime-adapter 的 refresher 以 `rawMessages[index]` 认定身份、以 `conversation[index]` 交付消息，错位后把一条真实 tool 消息误当"新认领的 user 消息"追加进工作副本——同一 tool_call_id 重复应答，上游以 "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'" 的误导文案 400。

触发窗口：并行工具批次部分落库（AsyncQueue 异步落库与 refresh 读库之间无屏障）+ mailbox 恰在窗口内认领消息。

## 平行数组的结构性弱点

对齐靠每个 mutation 点自觉维护（插入/丢弃/重排必须两边同步）。当前长度突变点只有 `closeOrphanedToolCalls` 一处（已修复并补 null 占位），但任何未来新增的视图变换点都是同类雷点；且契约成立与否无类型层面的强制，只能靠测试与断言兜底。

## 方案：来源身份随消息本体携带

不再维护平行数组，把来源身份作为 **ChatMessage 的内部字段**（如 `source_id: string | null`）随消息走，egress 前剥离。仓库已有完全相同的惯用法可循：`reasoning_blocks` / `provider_continuation`（messages 上、`stripInternalMessageFields` 剥离）、tool 的 `source`（tools 上、`stripInternalToolFields` 剥离）。

要点：

1. `messagesToConversation` 产出时给每条 entry 写 `source_id`（合成/占位消息为 null）；
2. `AgentContext.rawMessages` 整体退役；多 source 拼接处（`AgentContextBuilder`）不再需要 null 占位对齐；
3. refresh 识别投递物改为 `message.role === "user" && message.source_id != null && acceptedIds.has(message.source_id)`——单一数组自证身份，错位类别在结构上不可能出现；
4. monitoring 调试快照回绑元数据改为按 `source_id` 查 `Map<string, MessageInfo>`（组装时顺手构建）；
5. extensions / 内容投影按消息自身字段工作，不受影响。

## 迁移路径

- 一次性接口契约变更（`AgentContext`/`AgentContextContribution` 形状变化），不是数据形状变更，**不涉及 MIGRATIONS.md**（无持久化数据迁移）；
- 消费者清单：runtime-adapter refresher、monitoring `toContextHistoryItem`、extensions registry——全部同仓同步改，无跨包 wire 影响；
- 时机建议：与下一次 context 管线重构（如压缩视图、前置 source 体系调整）搭车，独立做收益不抵接口变更的评审成本。

## 当前状态（2026-09-01）

- **短期修复（已实施）**：`closeOrphanedToolCalls` 插入合成消息时向 originals 同步补 null 占位，恢复对齐契约；`sanitizeToolPairing`（agent-sdk）出口丢弃同一 tool_call_id 的第二次应答作纵深防御。回归夹具见 `backend-core/test/recent-messages-source.test.ts`（对齐不变量 + refresh 式筛选必须返回 user 消息本身）。
- **中间方案（已实施）**：refresher 投递与全量重建视图几何解耦——`RecentMessagesContextSource.projectRows()` 对"本轮认领/接受的 user 行"单独跑同一规范投影，不再从全量 conversation 按索引筛选。refresh 由此不再依赖对齐契约（本方案要消除的主要消费者），也省去每次投递的全量历史重建。
- 本方案（携带式来源）留作管线层的终态方向，届时 `rawMessages` 契约与 null 占位约定可一并退役。
