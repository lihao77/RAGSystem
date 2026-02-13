## 审计结论（现状快照）
- **多智能体拓扑**：HTTP/SSE 入口 → Orchestrator/Registry（单例）→（V1: master_agent 计划分解串行调度 / V2: master_agent_v2 ReAct 串行“Agent 作为工具”调用）→ 专业 ReActAgent（kgqa/chart/emergency）→ ToolExecutor → 外部依赖（LLM/图谱/Embedding 等）。入口与路由见 [agent.py](file:///d:/python/RAGSystem/backend/routes/agent.py#L360-L406)，编排见 [orchestrator.py](file:///d:/python/RAGSystem/backend/agents/orchestrator.py#L53-L172)，V2 执行见 [master_v2.py](file:///d:/python/RAGSystem/backend/agents/master_agent_v2/master_v2.py#L380-L647)。
- **通信形态**：Agent↔Agent 为**进程内直接函数调用**（非网络 RPC/队列），对外流式协议为 SSE(JSON)。
- **主要单点/热点**：Orchestrator/Registry 单例 + Master 中心化 + LLM 调用倍增 + 子任务串行执行 + `AgentContext.merge()` 为空导致重复调用/信息丢失风险（[base.py](file:///d:/python/RAGSystem/backend/agents/base.py#L112-L129)）。
- **循环依赖风险**：已通过“跳过 master_agent*”在 V1 分解与 V2 工具定义层面规避（[master_agent.py](file:///d:/python/RAGSystem/backend/agents/master_agent.py#L621-L627)，[agent_function_definitions.py](file:///d:/python/RAGSystem/backend/agents/master_agent_v2/agent_function_definitions.py#L17-L27)）。
- **重试/幂等**：仅看到 LLM provider 级重试与个别工具语义重试（[providers.py](file:///d:/python/RAGSystem/backend/llm_adapter/providers.py#L201-L321)，[tool_executor.py](file:///d:/python/RAGSystem/backend/tools/tool_executor.py#L259-L329)），缺少任务级幂等键/去重与可恢复执行。
- **可观测性**：日志为基础 logging（[app.py](file:///d:/python/RAGSystem/backend/app.py#L44-L47)），未实现 TraceId/SpanId 贯穿；requirements 有 opentelemetry 但未接入（[requirements.lock.txt](file:///d:/python/RAGSystem/backend/requirements.lock.txt#L38-L60)）。

## v2 多智能体拓扑图（拟交付物）
- 交付一份可维护的 Mermaid 图（放入 docs/ 或现有 MD），包含：入口、Orchestrator/Registry、MasterV1/V2、专业 Agent、Tools/外部依赖、SSE 数据流。
- 图中明确：
  - **控制流**（谁调用谁：函数调用/流式事件）
  - **数据流**（AgentContext、SSE event、tool invocation JSON）
  - **依赖**（LLM adapter、ToolExecutor、Skill loader）

## 架构层面改进（解耦与性能）
- **解耦策略 A：进程内事件总线（低成本）**
  - 引入 `EventBus` 接口（publish/subscribe），将“子 Agent 事件、tool 事件、指标事件”统一为事件流；MasterV2/ReActAgent 只发布事件，SSE 层只订阅与序列化。
  - 好处：弱化模块间直接耦合（SSE 不再依赖 agent 内部事件 dict 形状），便于做 schema 版本化与测试。
- **解耦策略 B：任务队列/消息队列（扩展到多进程/多机）**
  - 抽象 `AgentInvocationTransport`（inproc / redis-stream / rabbitmq），保持上层编排与协议一致；后续可将专业 Agent 迁移到 worker。
  - 明确“至少一次”投递语义，并通过幂等键 + 结果缓存/状态机实现去重。
- **性能关键改造点**
  - 为 V2 的 `actions[]` 增加可控并行（同一轮内并行执行可并行的子 Agent），并引入**共享 blackboard 的隔离策略**（命名空间或 copy-on-write）以避免并行写冲突。
  - 补全 `AgentContext.merge()`：至少合并关键结果摘要/结构化产物（而非仅 metadata），降低重复调用概率。
  - 对 system prompt / tool schema 构建做缓存（按 agent_name + enabled_tools + model 配置 key），减少重复字符串构建与 token 浪费。

## 通信与协议改进（序列化、版本兼容、重试幂等）
- **SSE 事件协议正规化**
  - 用 Pydantic/TypedDict 定义 `AgentEvent`（type、timestamp、trace_id、span_id、agent、tool、payload、schema_version）。
  - 路由层只发送这一套 schema；新增字段遵循向后兼容策略，并在 `schema_version` 递增时做兼容处理。
  - 评估序列化开销：
    - 减少高频 chunk 事件的字段重复（例如把不变字段放到 `stream_start`，chunk 只带增量内容与引用 id）。
- **Agent 调用协议正规化（V2 invoke_agent_*）**
  - 为 `invoke_agent` 的输入/输出建立统一 envelope：`{request_id, trace_id, agent, task, context_hint, timeout_ms, idempotency_key}` / `{request_id, status, result, error, metrics}`。
  - 明确版本兼容：参数新增默认值、字段弃用策略、严格校验与错误返回。
- **重试与幂等（任务级）**
  - 在 HTTP 入口支持 `Idempotency-Key`（或 `request_id`），将执行状态落库/缓存（内存/Redis 均可起步）；重复请求返回同一结果或同一 stream。
  - 为工具执行增加“幂等提示/重试策略”元数据（例如对写操作默认不重试，对读操作指数退避重试），并在日志/trace 中打点。

## 统一日志与追踪上下文（TraceId/SpanId）
- **Trace 生成与传播**
  - 在 Flask 层增加 middleware：生成/提取 `traceparent` 或 `X-Request-Id` → 写入 `g`，并注入到 `AgentContext`（新增字段）与每条 SSE event。
  - 在 Orchestrator/Master/ToolExecutor/LLM adapter 关键点创建 span，并记录：agent_name、tool_name、model、token、latency、retry_count。
- **日志结构化**
  - 引入 LoggerAdapter 或 logging Filter，将 `trace_id/session_id/agent_name` 作为统一字段；必要时切换 JSON formatter（不改变现有 logger 调用点，靠 handler/filter 注入）。
- **落地到现有依赖**
  - 复用已存在的 opentelemetry 依赖，优先接入 Flask instrumentation；导出端先用 OTLP/console（二选一）保证可用。

## 验证与度量（确保优化可回归）
- 增加轻量基准：
  - 统计一次请求的 LLM 调用次数、子 agent 次数、工具次数、总耗时、P50/P95。
  - SSE 事件总数/字节数，chunk 频率与序列化耗时。
- 增加单元/集成测试：
  - 事件 schema 校验（版本字段必填、字段兼容）。
  - 幂等键重复请求返回一致结果。
  - trace_id 在入口→master→子 agent→工具→SSE 全链路存在。

## 预期交付物（可直接落地到仓库）
- 一份 v2 多智能体 Mermaid 拓扑图 + 架构说明文档。
- 一套可版本化的 `AgentEvent`/`AgentInvocation` schema 与 SSE 输出统一实现。
- TraceId/SpanId 贯通 + 结构化日志注入 + 关键 span 打点。
- 任务级幂等键与可观测指标/基准测试。