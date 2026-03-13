# backend-fastapi 上下文升级路线图

> 更新时间：2026-03-13
> 适用范围：`backend-fastapi/agents/context/*`、`backend-fastapi/agents/core/*`、`backend-fastapi/services/conversation_store.py`、`backend-fastapi/execution/persistence/*`

---

## 1. 文档定位

这份文档不是替代已有方案，而是把已有结论整理成一条可执行的升级主线。

建议与以下文档配套阅读：

1. `context-manager-evolution-plan.md`
   - 说明当前上下文子系统已经完成了哪些结构收敛
2. `context-storage-refactor-plan.md`
   - 说明存储边界为什么需要继续拆层
3. `observation-materialization-migration-plan.md`
   - 说明工具结果 observation 为什么不能继续以“任意文本”方式污染主上下文

本路线图只回答三个问题：

1. 现在 FastAPI 上下文系统处在什么阶段
2. 后面应该先做什么，再做什么
3. 每一阶段做到什么程度才算收口

---

## 2. 当前基线判断

当前 `backend-fastapi` 的上下文系统已经具备“可用的主链”，但还没有进入“可扩展的记忆运行时”阶段。

现状可以概括为：

1. `ContextPipeline` 已经成为统一上下文准备入口。
2. 历史压缩、`seq`、`replaces_up_to_seq`、压缩事件持久化已经贯通。
3. observation 主链已经收敛到 `normalize -> decide -> materialize`。
4. `ArtifactStore` 已经独立，说明大结果外置的方向是对的。
5. 监控接口已经能暴露上下文快照和部分上下文指标。

但系统仍有四个明确缺口：

1. 会话消息、压缩摘要、执行 trace、artifact、memory 还没有彻底分层。
2. `ConversationStore` 仍是单表思路，摘要仍以消息语义落库。
3. prompt 预算仍接近单桶思路，尚未进入多来源预算仲裁。
4. 系统还没有正式的 `memory provider / context assembler / budget arbiter` 主干接口。

因此，当前最合理的阶段判断是：

1. 上下文主链：`已成型`
2. 存储边界：`未收口`
3. 预算治理：`基础可用`
4. 记忆分层：`尚未开始`

---

## 3. 路线总目标

后续升级不应继续围绕“怎么再压一点历史”展开，而应围绕下面四个目标：

1. 把上下文从“消息列表处理”升级成“多来源上下文组装”
2. 把上下文存储从“会话消息混装”升级成“分层存储域”
3. 把预算从“单次全量裁剪”升级成“多桶预算仲裁”
4. 把压缩系统从“历史摘要器”升级成“记忆与上下文治理子系统”

目标状态下，主链应是：

`Conversation Messages + Summary Checkpoints + Execution Trace + Artifact Records + Memory Providers -> ContextAssembler -> BudgetArbiter -> Final Prompt`

---

## 4. 设计原则

后续所有升级建议遵循以下原则：

1. 用户可见消息和系统内部执行痕迹必须分开。
2. 摘要是 checkpoint，不是普通聊天消息。
3. 大结果默认以 artifact 引用进入 prompt，而不是全文回灌。
4. 所有上下文来源都应先形成独立 bucket，再参与预算仲裁。
5. 新的上下文来源必须通过标准接口接入，而不是直接往 `ContextPipeline` 里加分支。
6. 所有裁剪、摘要、召回决策都应尽量可观测。

---

## 5. 分阶段路线

建议把升级路线拆为五个阶段，按顺序推进。

## Phase 1：切断错误上下文回灌

状态建议：`最优先`
周期建议：`短期`

### 目标

先修正当前最影响正确性的点：不要让执行中间痕迹继续以会话历史身份回灌下一轮 prompt。

### 需要完成的事情

1. `load_history_into_context()` 只装载真正的会话消息。
2. `StreamPersistenceHandler` 不再把 `react_intermediate` 写入消息历史。
3. 监控、回放、调试继续通过 `run_steps` 和 SSE 获取执行细节。
4. 为“会话消息边界”补回归测试，防止 trace 再次混入。

### 重点触达模块

1. `services/agent_api_runtime_service.py`
2. `execution/persistence/stream_handler.py`
3. `services/conversation_store.py`
4. `api/v1/monitoring.py`

### 验收口径

1. 下一轮 prompt 中不再出现旧 thought、旧 observation、旧中间工具结果。
2. 监控页仍可看到完整运行步骤。
3. 重连 SSE、run_steps 追踪、最终答案保存不回退。

### 这一步为什么先做

因为它直接影响模型输入正确性，是比“继续优化压缩效果”更高优先级的问题。

---

## Phase 2：把摘要从消息语义中拆出来

状态建议：`高优先级`
周期建议：`短期到中期`

### 目标

让“历史摘要”从 `messages` 中退出，成为独立的 summary checkpoint。

### 需要完成的事情

1. 新增 `conversation_summary_checkpoints` 或等价模型。
2. 压缩事件从“写一条带 metadata 的 system 消息”切换为“写 checkpoint”。
3. `resolve_compression_view()` 从主逻辑退化为兼容读取逻辑。
4. `ConversationStore` 增加 summary checkpoint 的读写接口。
5. 为 checkpoint 覆盖边界补表驱动测试。

### 重点触达模块

1. `services/conversation_store.py`
2. `agents/context/pipeline.py`
3. `agents/context/compression_view.py`
4. `execution/persistence/stream_handler.py`

### 验收口径

1. prompt 构造可以直接读取最新有效 checkpoint。
2. 会话消息表不再依赖伪装 `system` 消息承载摘要。
3. 旧 session 仍可通过兼容路径正常读取。

### 这一阶段的结果

完成后，系统会第一次真正建立“真实对话”和“上下文检查点”的边界。

---

## Phase 3：引入多桶预算与上下文装配器

状态建议：`中优先级`
周期建议：`中期`

### 目标

把当前的 `ContextPipeline` 从“整个上下文系统主入口”降级为“历史 bucket 管理器”，新增真正的上下文装配层。

### 需要完成的事情

1. 新增 `ContextAssembler`
   - 负责拉取 system、recent history、summary、memory、tool observation 等 bucket
2. 新增 `BudgetArbiter`
   - 负责多来源预算分配和裁剪顺序
3. 为不同 bucket 建立显式预算
   - `system`
   - `recent_history`
   - `summary`
   - `memory`
   - `tool_observation`
   - `reserve`
4. `BaseAgent` 改为调用 `ContextAssembler.build(...)` 获得最终 prompt。
5. `ObservationPolicy` 收窄职责，只处理 observation bucket 内部决策。

### 重点触达模块

1. `agents/core/base.py`
2. `agents/context/pipeline.py`
3. `agents/context/budget.py`
4. `agents/context/observation_policy.py`
5. 新增 `agents/context/assembler.py`
6. 新增 `agents/context/budget_arbiter.py`

### 验收口径

1. 每个上下文来源有清晰 bucket 和预算归属。
2. 当预算不足时，裁剪顺序和原因可解释。
3. 新增一个上下文来源时，不需要修改 `ContextPipeline` 主逻辑。

### 这一阶段的结果

完成后，上下文系统会从“单桶历史裁剪”进入“多来源 prompt 编排”阶段。

---

## Phase 4：Artifact 治理与 observation 生命周期收口

状态建议：`中优先级`
周期建议：`中期`

### 目标

让大 payload 外置不仅“能用”，还具备正式治理能力。

### 需要完成的事情

1. 新增 artifact 记录表或等价索引层。
2. `ArtifactStore` 从文件索引升级为“文件本体 + 结构化索引”双层模型。
3. artifact 引入显式生命周期状态：
   - `active`
   - `stale`
   - `deleted`
4. observation 物化结果与 artifact 索引建立稳定关联。
5. 监控面增加 artifact 占用、回收率、spill 率等指标。

### 重点触达模块

1. `agents/artifacts/artifact_store.py`
2. `agents/context/prompt_materializer.py`
3. `services/conversation_store.py` 或独立 artifact store persistence
4. `agents/monitoring/observation_window.py`

### 验收口径

1. 可以按 `session_id / run_id / tool_name` 查询 artifact。
2. artifact 的回收不再依赖“仅靠目录扫描”。
3. observation bucket 的外置比例和回收效果可观测。

### 这一阶段的结果

完成后，大结果不会只是“落了个临时文件”，而是纳入正式上下文治理。

---

## Phase 5：引入分层记忆与记忆提供者接口

状态建议：`长期能力建设`
周期建议：`中长期`

### 目标

把上下文系统从“对话历史治理”升级为“记忆运行时”。

### 需要完成的事情

1. 定义 `MemoryProvider` 接口。
2. 先实现 `EpisodicMemoryProvider`
   - 提取会话内可复用约束、阶段结论、用户确认事实
3. 预留 `SemanticMemoryProvider`
   - 用于长期偏好、稳定事实、跨 session 信息
4. Memory 检索结果通过 `ContextAssembler` 接入，而不是伪装成会话消息。
5. 为 memory 增加质量指标：
   - 命中率
   - 召回后使用率
   - 重复率
   - 对最终答案的帮助度

### 重点触达模块

1. 新增 `agents/context/memory/*`
2. `agents/core/base.py`
3. `agents/context/assembler.py`
4. `api/v1/monitoring.py`

### 验收口径

1. 新增记忆来源不需要修改历史压缩逻辑。
2. 长会话和跨任务场景下，不再只依赖滚动摘要维持上下文。
3. Memory 的收益可以通过指标进行评估，而不是只靠主观判断。

### 这一阶段的结果

完成后，系统才真正具备从“会话上下文管理”升级为“agent memory runtime”的基础。

---

## 6. 建议实施顺序

建议顺序不要调整，按下面推进：

1. `Phase 1`
2. `Phase 2`
3. `Phase 3`
4. `Phase 4`
5. `Phase 5`

原因如下：

1. `Phase 1` 修的是正确性问题。
2. `Phase 2` 修的是存储语义问题。
3. `Phase 3` 建的是扩展主干。
4. `Phase 4` 收的是 observation 与 artifact 的治理闭环。
5. `Phase 5` 才是记忆能力扩张。

如果跳过前两步直接做 memory，结果只会是在旧边界上继续叠复杂度。

---

## 7. 推荐里程碑

为了更适合研发排期，建议映射为四个里程碑。

### Milestone A：上下文输入纠偏

对应阶段：

1. `Phase 1`

关闭条件：

1. trace 不再回灌会话历史
2. prompt 输入边界可测试
3. SSE / run_steps 观测链路保持可用

### Milestone B：摘要与会话边界收口

对应阶段：

1. `Phase 2`

关闭条件：

1. summary checkpoint 独立落库
2. 历史摘要不再依附普通消息
3. 旧数据兼容读取通过

### Milestone C：上下文装配层落地

对应阶段：

1. `Phase 3`
2. `Phase 4`

关闭条件：

1. `ContextAssembler` 和 `BudgetArbiter` 上线
2. 多桶预算可观测
3. artifact 生命周期进入正式治理

### Milestone D：记忆运行时启用

对应阶段：

1. `Phase 5`

关闭条件：

1. `MemoryProvider` 接口稳定
2. episodic memory 可进入主链
3. 记忆收益具备基础量化指标

---

## 8. 配套指标建议

后续升级不能只看功能是否上线，还应同步补以下指标：

1. `history_replay_pollution_rate`
   - 会话历史中被判定为内部 trace 的占比
2. `compression_trigger_rate`
   - 压缩触发频率
3. `summary_checkpoint_coverage`
   - 摘要覆盖到的历史范围
4. `bucket_token_distribution`
   - 各 bucket 的 token 占比
5. `artifact_spill_rate`
   - observation 外置比例
6. `artifact_reuse_rate`
   - artifact 被后续引用的比例
7. `memory_hit_rate`
   - memory 检索命中率
8. `memory_use_rate`
   - 命中后实际进入 prompt 的比例

这些指标应该进入监控接口或 observation window 报告，而不是只停留在日志里。

---

## 9. 非目标

这份路线图当前不要求：

1. 一次性删除所有旧兼容逻辑
2. 一次性重写全部会话存储
3. 立即做跨用户长期记忆产品化
4. 立即把 artifact 接入对象存储
5. 立即统一 blackboard、memory、retrieval 为一个大模型

这些事情可以做，但不应先于主链边界收口。

---

## 10. 最终建议

如果只保留一句总判断，那就是：

`backend-fastapi` 的上下文系统下一步不应继续堆叠压缩逻辑，而应优先完成“输入纠偏 -> 存储拆层 -> 装配器化 -> 记忆分层”这条升级主线。

更具体地说：

1. 先修正错误回灌
2. 再拆摘要语义
3. 然后建立多桶上下文装配
4. 最后把记忆作为正式来源接入

完成这条路线之后，系统会从当前的：

`可用的上下文压缩链路`

升级为：

`可扩展的上下文与记忆运行时`
