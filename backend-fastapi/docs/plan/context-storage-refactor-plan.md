# 上下文存储重构方案

> 更新时间：2026-03-13
> 适用范围：`backend-fastapi/agents/context/*`、`backend-fastapi/services/conversation_store.py`、`backend-fastapi/execution/persistence/*`

---

## 1. 目标

本方案解决的不是“如何继续给现有上下文模块加功能”，而是：

1. 重新定义什么数据属于会话上下文。
2. 重新划分会话消息、执行痕迹、artifact、记忆的存储边界。
3. 让 prompt 组装从“回放大量历史和执行过程”变成“按来源选择必要上下文”。

本方案的核心判断如下：

1. 当前系统已经具备 `ContextPipeline + ObservationPolicy + PromptMaterializer + ArtifactStore` 的基础能力。
2. 当前真正的问题不是组件数量过多，而是存储边界不够干净。
3. 当前最需要修正的是：内部执行痕迹不应继续作为普通会话消息回装进下一轮上下文。

---

## 2. 当前问题

## 2.1 会话消息和执行痕迹混存

当前系统中：

1. 用户消息和最终 assistant 回复存入 `messages`。
2. `react_intermediate` 也会被持久化为普通消息。
3. 历史加载时会把 `user / assistant / system` 全部重新写入 `AgentContext.conversation_history`。

这会导致：

1. 旧 thought、旧 observation、旧控制性提示进入下一轮 prompt。
2. 会话历史逐渐退化为“执行日志回放”。
3. 压缩模块实际在压的是“聊天历史 + 内部执行过程”的混合体。

这不符合主流对话/RAG/Agent 系统的常见边界：执行 trace 应用于观测和回放，不应默认回灌为下一轮对话历史。

## 2.2 上下文来源尚未显式分层

当前上下文主要还是：

1. `system prompt`
2. 历史消息
3. 当前轮 `current_session`
4. 工具结果 observation

缺少显式来源桶：

1. recent conversation
2. summary checkpoint
3. retrieved memory
4. retrieved documents
5. tool observations
6. reserve budget

结果是：

1. 预算治理仍是单桶思路。
2. 系统无法表达“先压 observation 还是先压历史”。
3. 后续接入 memory provider 时会继续叠加复杂度。

## 2.3 `AgentContext` 语义偏重

当前 `AgentContext` 同时承载：

1. `conversation_history`
2. `intermediate_results`
3. `shared_data`
4. `blackboard`
5. parent-child fork/merge

这对多 Agent 协作不是错误，但它混合了：

1. 单次运行态状态
2. 协作共享态
3. 类似 memory 的长期语义预留

在尚未引入真正的分层 memory 之前，这种模型会放大理解成本。

## 2.4 压缩摘要仍依附于消息表

当前压缩摘要以 `system` 消息形式写入 `messages`，并依赖 `compression` / `replaces_up_to_seq` 语义恢复视图。

这个做法在过渡期有效，但存在问题：

1. 摘要本质上是“会话检查点”，不是普通聊天消息。
2. 同一个 `messages` 表同时承载真实对话和控制性结构。
3. 读取链路需要额外的 `resolve_compression_view()` 才能得到最终视图。

---

## 3. 设计原则

重构后遵循以下原则：

1. 用户可见对话和系统内部执行痕迹分开存储。
2. Prompt 只由“对当前任务有帮助的信息”组装，不做事件回放。
3. 摘要是检查点，不是普通消息。
4. Tool 大结果默认外置，用引用进入 prompt。
5. Memory 先分层建接口，再逐步落地，不一次性做大全。
6. 预算按来源分桶，而不是在最终消息列表上统一截断。

---

## 4. 目标架构

建议形成四类存储域。

## 4.1 Session Store

职责：

1. 存储用户消息。
2. 存储最终 assistant 回复。
3. 存储少量系统级会话元信息。

不存储：

1. thought
2. observation 原文
3. tool call step
4. stream 中间事件

建议模型：

1. `sessions`
2. `conversation_messages`
3. `conversation_summary_checkpoints`

## 4.2 Execution Trace Store

职责：

1. 存储 run/agent/tool 级执行事件。
2. 存储 thinking / observation / react intermediate。
3. 为监控、回放、调试、审计提供数据。

建议模型：

1. `runs`
2. `run_steps`
3. 可选 `run_step_blobs`

说明：

当前已有 `run_steps`，本方案要求保留并强化，而不是再把 trace 回写到消息表。

## 4.3 Artifact Store

职责：

1. 存储大文本、大 JSON、图表数据、地图数据、文件结果。
2. 用引用进入 prompt，而不是把大 payload 直接塞入消息。
3. 支持 TTL、回收、按 `session_id / run_id / tool_name` 检索。

建议模型：

1. 文件内容仍可落磁盘。
2. 索引记录从 JSONL 逐步升级到数据库表。

## 4.4 Memory Store

职责：

1. 存储“值得跨轮复用”的结构化记忆。
2. 与会话历史分离。

第一阶段只分两类：

1. `episodic_memory`
   - 某个 session 内阶段性结论、约束、用户已确认事实
2. `semantic_memory`
   - 稳定偏好、长期资料、跨 session 事实

说明：

如果当前产品没有跨 session 记忆需求，`semantic_memory` 可以先只预留接口，不落实现。

---

## 5. 建议的数据模型

以下是目标状态，不要求首轮迁移一次全部到位。

## 5.1 会话消息

```sql
CREATE TABLE conversation_messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT UNIQUE NOT NULL,
    session_id TEXT NOT NULL,
    role TEXT NOT NULL,              -- user / assistant
    content TEXT NOT NULL,
    message_type TEXT NOT NULL,      -- final / edited / retry
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

约束：

1. 默认只允许 `user / assistant`。
2. `system` 不再作为压缩摘要的主存储方式。

## 5.2 会话摘要检查点

```sql
CREATE TABLE conversation_summary_checkpoints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    summary_text TEXT NOT NULL,
    source_from_seq INTEGER,
    source_to_seq INTEGER NOT NULL,
    summary_kind TEXT NOT NULL,      -- rolling / retry / manual
    replaced_checkpoint_id TEXT,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

语义：

1. `source_to_seq` 表示该摘要覆盖到哪一条真实消息。
2. 同一 session 允许多条 checkpoint，但 prompt 默认只取最新有效的一条。
3. 原 `replaces_up_to_seq` 语义在这里保留，但不再依赖伪装成消息。

## 5.3 运行记录

```sql
CREATE TABLE runs (
    run_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    task_id TEXT,
    request_id TEXT,
    entry_agent_name TEXT,
    status TEXT NOT NULL,
    started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    finished_at TIMESTAMP
);
```

```sql
CREATE TABLE run_steps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    step_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    message_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

说明：

1. `thinking_complete`
2. `react_intermediate`
3. `call_tool_start/end`
4. `call_agent_start/end`

都只进入 `run_steps`，不再回写 `conversation_messages`。

## 5.4 Artifact 索引

```sql
CREATE TABLE artifact_records (
    artifact_id TEXT PRIMARY KEY,
    session_id TEXT,
    run_id TEXT,
    tool_name TEXT,
    artifact_type TEXT NOT NULL,
    path TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    status TEXT NOT NULL,            -- active / stale / deleted
    expires_at TIMESTAMP,
    metadata TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

说明：

1. 文件本体仍可保留在磁盘。
2. 清理和检索基于表记录，不再以 JSONL 作为长期主索引。

## 5.5 Memory 记录

```sql
CREATE TABLE memory_records (
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,             -- session / user / global
    memory_type TEXT NOT NULL,       -- episodic / semantic
    session_id TEXT,
    user_id TEXT,
    content TEXT NOT NULL,
    summary TEXT,
    tags TEXT,
    source_run_id TEXT,
    importance REAL DEFAULT 0,
    last_accessed_at TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

说明：

1. 第一阶段可以先不做向量化。
2. 先把“可被检索的记忆对象”与会话消息物理分离。

---

## 6. 目标上下文组装流程

重构后，单轮 prompt 组装应统一走一个入口，例如：

`ContextAssembler.build(session_id, user_input, run_id, agent_role)`

建议输入来源按顺序处理：

1. system prompt
2. session recent messages
3. latest summary checkpoint
4. episodic memory hits
5. semantic memory hits
6. retrieved documents
7. current run tool observations
8. reserve budget

每类来源都必须先形成独立 bucket，再参与预算仲裁。

---

## 7. 预算设计

## 7.1 显式预算桶

建议最少拆成六桶：

1. `system`
2. `recent_history`
3. `summary`
4. `memory`
5. `tool_observation`
6. `reserve`

## 7.2 预算优先级

默认保留优先级从高到低：

1. `system`
2. `recent_history`
3. `summary`
4. `memory`
5. `tool_observation`
6. `reserve`

当预算不足时：

1. 先缩减 `tool_observation`
2. 再缩减 `memory`
3. 再缩减 `recent_history`
4. `summary` 只在极端情况下重算
5. `system` 不参与普通裁剪

## 7.3 观察结果策略

`ObservationPolicy` 仍然保留，但职责要收窄为：

1. 判断工具结果是 inline / summarize / artifact_ref
2. 给出 observation bucket 的预算建议

它不负责：

1. 决定整个 prompt 总体预算
2. 决定历史和 memory 的相对优先级

这部分应交给统一的 `ContextAssembler` 或 `BudgetArbiter`。

---

## 8. 模块职责调整

## 8.1 保留的模块

1. `ContextPipeline`
2. `ObservationPolicy`
3. `PromptMaterializer`
4. `ArtifactStore`
5. `ObservationWindowCollector`

## 8.2 需要调整的职责

### `ContextPipeline`

从：

1. 直接读取 `conversation_history`
2. 直接做压缩和最终消息拼装

调整为：

1. 只负责历史 bucket 的压缩策略
2. 不再直接代表整个上下文系统

### 新增 `ContextAssembler`

职责：

1. 拉取各来源 bucket
2. 调用预算仲裁器
3. 产出最终 `messages`

### 新增 `BudgetArbiter`

职责：

1. 对多来源 bucket 做裁剪与排序
2. 记录“为何裁剪”的决策信息

### `ConversationStore`

从：

1. 会话消息存储
2. 压缩摘要消息写入
3. artifact 清理触发

调整为：

1. 只负责 session / conversation message / summary checkpoint 的持久化
2. 不再负责 trace 语义
3. 不再以消息形式承载压缩摘要

### `StreamPersistenceHandler`

从：

1. 持久化 trace
2. 持久化 final answer
3. 持久化 react intermediate 为消息

调整为：

1. 持久化 trace 到 `run_steps`
2. 持久化 final answer 到 `conversation_messages`
3. 不再把 `react_intermediate` 写入会话消息

---

## 9. 迁移步骤

## Phase 1：切断错误回灌

目标：

1. 停止把执行痕迹混入会话历史。

动作：

1. `load_history_into_context()` 只加载真正的对话消息。
2. `StreamPersistenceHandler` 不再把 `react_intermediate` 写入消息表。
3. 前端调试和监控继续从 `run_steps` / SSE 读数据。

验收：

1. 下一轮 prompt 不再出现旧 thought / 旧 observation。
2. 监控页仍可看到完整执行过程。

## Phase 2：引入摘要检查点表

目标：

1. 让压缩摘要从普通消息中剥离。

动作：

1. 新增 `conversation_summary_checkpoints`。
2. `compression_summary` 事件改写为 checkpoint。
3. `resolve_compression_view()` 逐步退化为兼容读取逻辑。

验收：

1. prompt 组装可直接读取最新 checkpoint。
2. 不再依赖 `system + compression metadata` 恢复历史视图。

## Phase 3：建立多桶上下文组装

目标：

1. 让上下文治理从单桶裁剪变成多来源仲裁。

动作：

1. 新增 `ContextAssembler`。
2. 新增 `BudgetArbiter`。
3. `BaseAgent` 改为调用 `ContextAssembler` 生成最终 prompt。

验收：

1. system/history/memory/tool_result 的裁剪顺序可配置。
2. 预算决策可观测。

## Phase 4：Artifact 索引治理

目标：

1. 让 artifact 生命周期进入正式治理。

动作：

1. 新增 `artifact_records` 表。
2. `ArtifactStore` 同步写 DB 索引。
3. 清理逻辑改为记录驱动。

验收：

1. 可以按 session/run 查询 artifact。
2. 可以区分 `active / stale / deleted`。

## Phase 5：Memory Provider 接口

目标：

1. 为后续长会话和跨任务记忆预留标准入口。

动作：

1. 增加 `MemoryProvider` 接口。
2. 增加 `EpisodicMemoryProvider` 默认实现。
3. 可选接入向量检索或规则检索。

验收：

1. memory 不再通过历史消息伪装进入上下文。
2. 新增 memory 来源不需要改 `ContextPipeline` 主逻辑。

---

## 10. 非目标

本方案当前不要求：

1. 一次性完成长期记忆产品化。
2. 一次性把所有 artifact 改成对象存储。
3. 一次性删除所有旧兼容逻辑。
4. 立即让多 Agent blackboard 与 memory 完整统一。

---

## 11. 推荐的首轮落地顺序

建议按以下顺序实施：

1. 先做 Phase 1
2. 再做 Phase 2
3. 然后做 Phase 3
4. 最后再做 Phase 4 和 Phase 5

原因：

1. Phase 1 可以最快修正当前最真实的问题。
2. Phase 2 能把“摘要是不是消息”的语义收干净。
3. Phase 3 完成后，后续 memory 接入才不会继续污染主链路。
4. Artifact 和长期 memory 治理都应在主上下文边界收敛后推进。

---

## 12. 最终判断

当前系统不需要推翻重来。

应该做的是：

1. 保留已有的上下文治理基础设施。
2. 重新划清“会话消息、执行痕迹、artifact、memory”的存储边界。
3. 把上下文系统从“历史压缩器”升级为“多来源上下文组装器”。

如果按本方案执行，系统会从当前的：

`会话历史 + 中间执行过程混合压缩`

演进为：

`会话消息 / 摘要检查点 / 执行 trace / artifact / memory 分层治理`

这才是后续长会话、多 Agent、检索增强场景下更稳定的主线。
