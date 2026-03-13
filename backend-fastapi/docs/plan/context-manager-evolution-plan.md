# 上下文系统演进计划（状态版）

> 更新时间：2026-03-12
> 适用范围：`backend-fastapi/agents/context/*`、相关持久化/监控链路

---

## 1. 当前结论

原计划围绕 `agents/context/manager.py` 展开，但当前实现已经完成了主要拆分，`manager.py` 已不存在。

现状应理解为：

1. `ContextPipeline` 已经是上下文主入口。
2. `resolve_compression_view()` 已经独立为 `agents/context/compression_view.py`。
3. observation 链路已经收敛为 `ToolExecutionResult -> ObservationPolicy -> PromptMaterializer`。
4. `seq` 与 `replaces_up_to_seq` 语义已经贯通到内存模型、持久化和压缩事件链路。
5. `ArtifactStore` 已补充 artifact 元数据索引、`session_id` 跟踪、TTL 清理能力。
6. 预算体系已从散落常量收敛为显式 `ContextBudgetProfile`，以 `worker` / `orchestrator` 区分角色语义。
7. 系统整体不再处于“准备重构”阶段，而是处于：
   - `Phase 1` 基本完成
   - `Phase 2` 部分完成
   - `Phase 3` 尚未开始

---

## 2. 状态标记

- `已完成`：已经在代码中稳定落地
- `进行中`：已有实现，但未达到原计划目标
- `待开始`：尚未进入实施
- `已替代`：原任务目标已被更彻底的重构覆盖

---

## 3. 当前架构快照

### 3.1 主体结构

当前上下文子系统核心组件如下：

1. `agents/context/pipeline.py`
   - 上下文准备主入口
   - 执行压缩、滑窗降级、session trim、预算兜底
2. `agents/context/compression_view.py`
   - 负责解析持久化摘要和压缩视图
3. `agents/context/config.py`
   - 承载基础上下文配置
4. `agents/context/budget.py`
   - 提供统一预算计算函数与显式 budget profile
5. `agents/context/observation_policy.py`
   - 负责 observation 决策
6. `agents/context/prompt_materializer.py`
   - 负责 observation 文本物化
7. `agents/context/observation_formatters/*`
   - 承载具体渲染策略
8. `agents/artifacts/artifact_store.py`
   - 承担大结果落盘
9. `agents/monitoring/observation_window.py`
   - 记录 materialization / spill / compression / trim 指标

### 3.2 关键事实

1. `manager.py` 已删除，说明“拆分职责”不再只是计划。
2. `Message.seq` 已为显式字段，不再依赖 `metadata['seq']`。
3. 历史装载已直接回填 `seq`。
4. 压缩摘要事件已携带 `replaces_up_to_seq`。
5. Agent 已不再依赖 `ObservationFormatter` 外观类，直接走 policy + materializer。
6. `ArtifactStore` 已记录 artifact 元数据，支持按记录回收 + TTL 清理。
7. `BaseAgent._setup_react_runtime()` 已按 budget profile 统一生成上下文预算配置。

---

## 3.3 2026-03-12 已新增落地点

本轮新增且已验证的内容：

1. `resolve_compression_view()` 已补系统级回归测试
   - 覆盖多摘要、`seq is None`、`replaces_up_to_seq`、metadata 非法 JSON、持久化往返链路
2. `ArtifactStore` 已增加 `ArtifactRecord`
   - 记录 `session_id`、`tool_name`、`created_at`、`expires_at`
   - 暴露 `list_records()`
   - 清理由“仅目录扫描”升级为“索引优先 + 兼容旧扫描”
3. budget 体系已增加 `ContextBudgetProfile`
   - 当前有 `worker` / `orchestrator` 两个角色 profile
   - 两者共享同一 context budget 基线，角色差异主要留在 observation materialization 策略
   - `BaseAgent` 初始化上下文运行时时统一按 profile 注入默认值
4. `agents/tests/test_core/` 已完成旧编排器测试路径向 `orchestrator` 结构的迁移
   - 当前 `pytest agents/tests/test_core -q` 已通过

---

## 4. 原计划项状态总览

## 4.1 高优先级项

### A. 拆分文件职责，降低误导性

状态：`已完成`

结果：

1. `ContextConfig` 已拆到 `context/config.py`。
2. `resolve_compression_view()` 已拆到 `context/compression_view.py`。
3. `ObservationFormatter` 已拆到 `context/observation_formatter.py`。
4. 原 `manager.py` 已不再保留兼容层，而是直接退出实现。

判断：

这项已超出原计划的最低目标，属于“完成且进一步演进”。

### B. 修复/规避 `seq` 语义弱化问题

状态：`已完成`

结果：

1. `agents/core/models.py` 的 `Message` 已增加显式 `seq` 字段。
2. `AgentContext.add_message()` 已支持传入 `seq`。
3. `load_history_into_context()` 已直接把 `seq` 写入 `Message`。
4. `ContextPipeline` 读写上下文时会保留 `seq`。
5. 压缩事件和数据库持久化链路已支持 `replaces_up_to_seq`。

判断：

原计划中的正确性风险已被实质修复。

### C. 为 `resolve_compression_view()` 建立系统级测试

状态：`已完成`

结果：

1. `resolve_compression_view()` 已独立为单独模块。
2. 已补独立测试文件，覆盖多摘要、`seq is None`、`replaces_up_to_seq`、metadata 非法 JSON。
3. 已补 `ConversationStore -> resolve_compression_view()` 持久化链路回归。
4. 相关回归测试已纳入 `agents/tests/test_core/` 并通过。

判断：

该项已满足 `Phase 1` 的主要关闭条件。

---

## 4.2 中优先级项

### D. `ObservationFormatter` 策略化

状态：`已完成`

结果：

1. 已存在 `ObservationFormatterRegistry`。
2. 已拆分 `Skills`、`Chart`、`Map`、`LargePayload`、`Text`、`Json`、`Fallback` 等 formatter。
3. `ObservationFormatter` 现在主要作为兼容外观类。

判断：

该项已达到原计划目标。

### E. 大结果落盘机制生命周期治理

状态：`进行中`

已完成部分：

1. 已存在独立 `ArtifactStore`，不再由 formatter 直接拼路径写文件。
2. 已有统一临时目录路径约定。
3. 已有清理逻辑，由 `ConversationStore` 定期触发。
4. 已有 artifact 保存指标接入 `ObservationWindowCollector`。
5. 已有 artifact 元数据索引层（`ArtifactRecord` + JSONL index）。
6. `session_id`、`tool_name`、创建时间、TTL 已进入 artifact 元数据和索引记录。
7. 清理已升级为“记录驱动 + TTL 回收”，并兼容旧目录扫描。

未完成部分：

1. 元数据索引目前仍是文件索引，不是数据库或对象存储级治理。
2. `session_id` 已进入记录层，但还未参与路径分区或跨会话查询接口设计。
3. 还没有 artifact 的正式生命周期状态机（active / stale / archived / deleted）。

判断：

这项已从“仅可用”进入“基础治理可用”阶段，但还没有达到平台级生命周期管理。

### F. token 预算控制更精细

状态：`进行中`

已完成部分：

1. 已抽出 `compute_context_budget()`。
2. 已把上下文预算兜底倍数收敛为统一基线，不再按 agent 角色降低总预算。
3. `ContextPipeline` 已实现压缩阈值、session trim、预算 safety net。
4. 已增加显式 `ContextBudgetProfile`。
5. `worker` / `orchestrator` 已通过 profile 统一注入预算默认值，而不再依赖调用侧散落常量。

未完成部分：

1. 还没有多桶预算模型。
2. 还没有 system/history/session/tool_result/reserve 的显式预算分配。
3. 还没有预算仲裁器来决定先压哪个上下文来源。

判断：

当前已完成“显式 profile 收敛”，但整体仍属于单桶预算阶段，尚未进入多桶编排。

---

## 4.3 中长期项

### G. 从“压缩历史”升级为“分层记忆”

状态：`待开始`

现状：

1. 当前仍是单层历史 + 摘要替换 + 滑窗保留。
2. 尚未看到 `working / episodic / semantic memory` 的明确模型分层。

### H. 引入可观测性与压缩质量评估

状态：`进行中`

已完成部分：

1. 已记录 compression、trim、spill、artifact 等指标。
2. 已能输出 observation window 报告。

未完成部分：

1. 还没有 compression regret rate。
2. 还没有摘要质量评估或召回收益评估。
3. 还没有把这些指标上升为统一上下文治理指标体系。

### I. 为后续检索增强上下文做接口预留

状态：`待开始`

现状：

1. 还没有明确的 memory provider / extra context provider 接口。
2. 还没有统一的上下文来源排序与预算仲裁器。

---

## 5. 分阶段状态

## Phase 1：结构收敛与风险修复

总体状态：`已完成`

### 原目标

1. 修正模型与内存语义
2. 把关键逻辑稳定下来

### 任务状态

1. 给 `Message` 增加 `seq` 字段：`已完成`
2. 修正历史装载和回写路径，确保 `seq` 不丢：`已完成`
3. 为 `resolve_compression_view()` 增加完整单测：`已完成`
4. 拆分 `ObservationFormatter` 到独立文件：`已完成`
5. 为 `ContextManager` 增加弃用注释或兼容说明：`已替代`
   - 原因：`manager.py` 已被移除，兼容层目标已失效

### 当前判断

`Phase 1` 已达到关闭条件，后续只需以回归测试维持稳定性。

---

## Phase 2：能力解耦与可观测

总体状态：`部分完成`

### 原目标

1. 提升可维护性
2. 增强运行时可诊断性

### 任务状态

1. 引入 observation formatter strategy：`已完成`
2. 抽象临时文件 artifact 服务：`进行中`
3. 增加 compression / trim / spill 监控指标：`已完成`
4. 为不同 Agent 提供独立预算 profile：`已完成`

### 当前判断

`Phase 2` 已经推进到“artifact 基础治理 + 预算 profile 收敛”阶段，下一缺口是多桶预算和更完整的 artifact 生命周期。

---

## Phase 3：多层记忆与检索融合

总体状态：`待开始`

### 原目标

1. 让上下文系统从“裁剪器”升级为“记忆编排器”

### 任务状态

1. 引入 `working / episodic / semantic memory` 分层：`待开始`
2. 支持外部 memory provider：`待开始`
3. 增加上下文来源排序与预算仲裁机制：`待开始`
4. 对摘要质量和召回收益做评估：`待开始`

---

## 6. 建议后的下一步

基于当前真实进度，建议优先级调整为：

1. 先把预算体系从 profile 推进到多桶预算
   - 引入 `system / history / current_session / tool_result / reserve` 显式分桶
   - 增加预算仲裁器，决定先压哪个桶
2. 再把 `ArtifactStore` 从“基础治理”补到“治理型服务”
   - 明确 artifact 生命周期状态
   - 评估是否把索引从 JSONL 升级到 DB 记录
   - 让 `session_id` 支持更直接的查询和回收策略
3. 然后引入压缩质量治理
   - 增加 compression regret rate
   - 增加摘要质量和召回收益评估
4. 最后进入多层记忆与检索融合
   - 这是下一阶段能力升级，不应先于预算仲裁和治理指标收敛

---

## 7. 更新后的验收口径

### Phase 1 关闭条件

1. `resolve_compression_view()` 有完整表驱动测试
2. 多摘要和压缩边界回归测试通过
3. `seq` / `replaces_up_to_seq` 链路有回归保障

当前状态：`已满足`

### Phase 2 关闭条件

1. artifact 有统一元数据与生命周期管理
2. 压缩、trim、spill 指标可稳定输出与消费
3. 不同 Agent 的上下文预算语义由显式 profile 管理，context baseline 保持一致

当前状态：`部分满足`
已满足第 2、3 项，第 1 项已进入基础治理阶段但未完全关闭。

### Phase 3 启动条件

1. `Phase 1` 和 `Phase 2` 的正确性与治理问题收敛
2. 长会话或跨任务场景开始成为主要瓶颈

---

## 8. 最终判断

这份计划不应再描述“是否要从 `manager.py` 拆出去”，因为这一步已经完成。

更新后的定位应是：

1. 短期任务：补测试、补 artifact 治理、补预算 profile
2. 中期任务：推进多桶预算、artifact 生命周期治理、压缩质量评估
3. 长期任务：进入多层记忆与检索融合

当前最准确的阶段表述是：

- `Phase 1`：已完成
- `Phase 2`：部分完成
- `Phase 3`：尚未开始
