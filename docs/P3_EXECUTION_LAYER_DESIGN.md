# P3 执行平面设计文档（进程内最小方案）

状态：Phase 1-7 已落地（进程内最小方案）  
日期：2026-03-08  
关联文档：`docs/ARCHITECTURE_BOUNDARIES.md`
实施清单：`docs/P3_EXECUTION_LAYER_CHECKLIST.md`

## 1. 背景

根据 `docs/ARCHITECTURE_BOUNDARIES.md` 的 P3 目标，当前系统下一阶段的重点不是立刻引入更重的调度基础设施，而是先把“执行控制”从 Route、局部 Helper 和 Integration Manager 中收口成统一的进程内执行层。

当前仓库已经具备以下基础条件：

- `RuntimeContainer` 已是运行时装配中心。
- `TaskRegistry` 已承担部分内存级任务状态与取消能力。
- `SessionEventBusManager`、`EventBus`、`SSEAdapter` 已形成较成熟的通知链路。
- Agent 长任务已经形成会话级事件流、事件回放和重连机制。

但与此同时，执行平面仍然是分散的：

- Agent 流式任务由 Route 直接创建后台线程。
- 节点执行仍然由 Web 请求线程直接触发和承载。
- MCP 长任务和连接操作由 `client_manager` 自行维护后台事件循环线程。

因此，P3 的目标应是先在现有结构上建立一个**最小 execution layer**，统一任务入口、生命周期、取消、超时和状态记录，再逐步推动各执行类型接入。

## 2. 设计目标

本轮 P3 只解决“执行入口和控制语义统一”的问题，不追求一次性重构所有业务逻辑。

### 2.1 必须达成的目标

- 先做**进程内方案**。
- 不引入新的重基础设施。
- Route 不再直接起线程。
- 节点执行、Agent 长任务、MCP 长任务尽量走同一入口。
- 取消、超时、状态记录的语义在不同执行类型间尽量一致。
- 尽量复用现有 `TaskRegistry`、事件总线、SSE、`RuntimeContainer`。

### 2.2 本轮非目标

以下内容明确不作为 P3 第一阶段目标：

- 不迁移到 ASGI。
- 不引入 Celery、Redis、RQ、独立 worker 进程等新基础设施。
- 不重写 `MCPClientManager` 内部 asyncio loop 模型。
- 不批量修改全部 Node 的 `execute()` 签名。
- 不重构现有 Agent 业务事件和落库语义。
- 不合并当前 `EventBus` 与 `TaskRegistry` 两套审批/等待模型。

## 3. 当前现状盘点

### 3.1 `backend/routes/agent_api/stream_run.py`

#### 当前直接管理的内容

- **线程/任务生命周期**
  - Route 内部创建 `threading.Thread`，并直接 `start()`。
  - 在线程启动后再调用 `TaskRegistry.register(...)`。
- **超时**
  - Route 本身没有统一的执行超时控制。
  - 超时主要依赖 Agent 内部调用链、LLM Provider、工具自身配置。
- **取消**
  - Route 创建 `cancel_event` 并塞入 `AgentContext.metadata`。
  - `stream_helpers.create_stream_subscriptions(...)` 订阅 `USER_INTERRUPT` 并调用 `cancel_event.set()`。
  - `/stream/stop` 端点同时向事件总线发布 `USER_INTERRUPT`，并直接调用 `TaskRegistry.cancel(session_id)`。
- **状态记录**
  - Route 先用 `TaskRegistry.get_status(session_id)` 做同 session 并发拒绝。
  - 线程运行状态、审批等待、输入等待等都挂在 `TaskRegistry`。
  - 中间过程和最终答案通过事件订阅写入 conversation store / run_steps。
- **事件通知**
  - 通过 `get_session_event_bus(session_id)` 获取会话总线。
  - `SSEAdapter` 负责把事件转为 SSE 输出。

#### 当前主要问题

- Route 直接持有线程生命周期，违反 P3 目标边界。
- “先检查状态、后起线程、再注册”的顺序有竞争窗口。
- 取消语义分散在 Route、`TaskRegistry`、事件订阅和 Agent 内部 `_check_interrupt()` 之间。
- “中断”与“完成”的最终状态存在不一致风险：Agent 内部可能发布 `run_end(status="interrupted")`，但线程包装层可能仍标记 `completed`。
- 持久化订阅、SSE 生命周期、线程状态和 run_steps 落库虽然已解耦，但控制逻辑仍分散在多个 helper 和 route 中，维护成本高。

### 3.2 `backend/routes/nodes.py`

#### 当前直接管理的内容

- **线程/任务生命周期**
  - Route 不创建后台线程，但直接在 Web 请求线程中同步触发 `NodeService.execute_node(...)`。
- **超时**
  - Route 和 `NodeService` 都没有统一超时控制。
  - 个别 Node 自己可能在内部调用第三方时设置 timeout，但没有统一约束。
- **取消**
  - 当前没有统一取消机制。
  - `INode` 接口也没有通用 cancel token 或 execution context。
- **状态记录**
  - 没有接入 `TaskRegistry`。
  - `NodeStatus` 枚举存在，但执行链当前没有统一使用。
- **事件通知**
  - 当前没有接入 `EventBus` / session 事件总线 / SSE。

#### 当前主要问题

- 节点执行仍是请求线程直跑，不利于统一执行平面。
- 无法与 Agent / MCP 共享取消、状态、超时、观测语义。
- 对长耗时 Node 没有统一保护，容易造成请求阻塞。
- 即使未来需要支持 Node 事件流或后台化，也没有统一插入点。

### 3.3 `backend/mcp/client_manager.py`

#### 当前直接管理的内容

- **线程/任务生命周期**
  - `startup()` 中自行创建 asyncio event loop，并在后台 daemon 线程运行。
  - 对外暴露同步 API，通过 `_run_async()` 将 coroutine 投递到后台 loop 后同步等待。
- **超时**
  - `connect_server()` / `call_tool()` / `disconnect_server()` 使用 `future.result(timeout=...)` 控制等待时间。
  - timeout 值来自 server config 或固定值。
- **取消**
  - 当前没有统一的调用级 cancel handle。
  - timeout 后并未形成清晰的取消闭环；更接近“调用方放弃等待”。
- **状态记录**
  - 仅维护连接级状态：`disconnected` / `connecting` / `connected` / `error`。
  - 没有接入 `TaskRegistry`。
  - 没有统一的 task_id / run_id / session_id 级执行状态。
- **事件通知**
  - 没有直接接入 `EventBus` / SSE。

#### 当前主要问题

- `client_manager` 同时承担了“连接管理器”和“执行层桥接器”的职责，边界偏重。
- 对 MCP 工具调用缺少统一 task 语义，无法与 Agent / Node 共用取消和状态模型。
- timeout 不是完整取消，后台 coroutine 可能继续执行。
- Route、Service、Tool Dispatcher 都直接依赖 `MCPClientManager`，不利于后续统一入口。

## 4. 当前能力可复用性评估

### 4.1 `TaskRegistry`

#### 可复用点

- 已有线程安全注册表。
- 已支持并发拒绝、任务运行状态查询、取消信号分发。
- 已绑定审批等待、用户输入等待等与 Agent 长任务强相关的能力。
- 已支持持久化订阅 ID 清理。

#### 当前限制

- 主索引语义偏向 `session_id -> running task`。
- `TaskInfo` 强绑定 `thread`、`cancel_event`，更偏向现有 Agent 线程模型。
- 状态集合较少，缺少 `starting`、`cancel_requested`、`timed_out` 等中间态。
- 缺少显式 `task_id` 与 `concurrency_key` 语义。

#### 设计判断

P3 第一阶段不应废弃 `TaskRegistry`，而应将其**向通用 execution registry 方向最小扩展**：

- 内部引入 `task_id` 主键；
- 保留 session 兼容查询接口；
- 扩展状态模型；
- 保持现有 Agent 等待/审批语义不变。

### 4.2 事件总线 / Session Manager / SSE

#### 可复用点

- `SessionEventBusManager` 已支持按 session 隔离事件总线、TTL 清理和重连友好。
- `EventBus` 已支持同步/异步发布、历史事件回放、订阅过滤。
- `SSEAdapter` 已是成熟的通知适配层。
- Agent 链路已经验证了“事件总线 + SSE + 回放”的可用性。

#### 当前限制

- 这套设施本质上是**通知平面**，不是执行所有权中心。
- 当前事件类型大多围绕 Agent 生命周期设计，Node / MCP 还没有统一接入约定。
- 会话级事件总线对非 session 场景需要明确挂载策略。

#### 设计判断

P3 应继续把它们定位为**通知层和观测层**，而不是取代 `ExecutionService`。执行层负责：

- 提交任务；
- 维护状态；
- 管理 cancel / timeout；
- 触发统一事件。

通知层继续负责：

- 事件广播；
- SSE 转发；
- 重连回放；
- 会话级隔离。

### 4.3 `RuntimeContainer`

#### 可复用点

- 已是进程级运行时装配中心。
- 已能统一提供 `task_registry`、`session_manager`、`event_bus`、`mcp_manager`。
- 已接入应用启动和关闭生命周期。

#### 设计判断

`ExecutionService` 应直接进入 `RuntimeContainer`，成为执行平面的唯一装配入口。P3 不应再新增新的全局单例通道。

## 5. 设计原则

P3 第一阶段遵循以下原则：

1. **统一入口，局部适配**  
   先统一任务入口，不强求一次统一所有内部执行实现。

2. **进程内优先**  
   先把 Web 进程内执行模型收口，再决定是否需要更重调度设施。

3. **保留通知资产**  
   不重建第二套事件 / SSE 模型。

4. **兼容优先**  
   对现有 Route 响应、会话重连、审批输入链路保持兼容。

5. **先收执行控制，再收业务副作用**  
   run_steps、消息落库、工具审批等业务逻辑先留在 adapter/业务层，不急于抽到通用执行层。

## 6. 最小执行层设计

### 6.1 目标位置

建议将执行层放在 `services` 与更底层 integration/runtime 之间，形成如下依赖关系：

`routes -> services -> execution layer -> domain/integrations/runtime`

其中：

- Route 负责协议适配和响应格式。
- 业务 Service 负责用例编排。
- Execution Layer 负责：
  - 提交任务
  - 生命周期驱动
  - 取消
  - 超时
  - 状态记录
  - 统一事件注入
- 具体 Agent / Node / MCP 逻辑仍留在各自实现中。

### 6.2 核心职责

最小 execution layer 只承担以下职责：

- 接收统一的执行请求。
- 分配 `task_id`。
- 检查并占用并发槽位（session 或其他 key）。
- 创建和管理 `cancel_event`。
- 在进程内 runner 中启动执行。
- 记录状态迁移。
- 在需要时发布统一生命周期事件。
- 暴露统一查询 / 取消接口。

### 6.3 核心抽象

建议引入以下轻量模型和服务：

#### `ExecutionRequest`

表示一次执行请求，最小字段建议包括：

- `execution_kind`: `agent_stream` | `node_execute` | `mcp_tool_call` | `mcp_connect` | ...
- `session_id`: 可选
- `run_id`: 可选
- `concurrency_key`: 可选，用于统一并发占用
- `timeout_seconds`: 可选
- `metadata`: 任意补充信息
- `payload`: 交给具体 adapter 的原始输入

#### `ExecutionContext`

表示实际执行上下文，最小字段建议包括：

- `task_id`
- `execution_kind`
- `session_id`
- `run_id`
- `cancel_event`
- `event_bus`
- `task_registry`
- `metadata`

#### `ExecutionHandle`

表示一次已提交的执行任务，最小字段建议包括：

- `task_id`
- `session_id`
- `run_id`
- `status`
- `started_at`
- `thread` 或 runner-specific handle
- `cancel()`
- `get_status()`

#### `ExecutionResult`

表示执行完成后的结果，最小字段建议包括：

- `success`
- `status`
- `data`
- `error`
- `finished_at`

#### `ExecutionService`

执行层统一入口，对外提供至少两类能力：

- `submit(request, adapter)`：后台执行，返回 `ExecutionHandle`
- `run(request, adapter)`：同步执行，但仍走统一状态和事件包装

#### `InProcessExecutionRunner`

P3 第一阶段唯一 runner，实现：

- 起线程
- 等待完成
- best-effort cancel
- timeout 包装

### 6.4 建议状态模型

建议执行层统一使用以下状态集：

- `starting`
- `running`
- `cancel_requested`
- `completed`
- `failed`
- `interrupted`
- `timed_out`

说明：

- `starting` 用于避免当前“线程已起但未登记”的窗口。
- `cancel_requested` 用于表达取消已发出但任务尚未退出。
- `interrupted` 用于协作式取消后正常收束。
- `timed_out` 与 `failed` 分开，避免“超时 == 异常”语义混淆。

### 6.5 并发与占位模型

第一阶段建议保留“单 session 只允许一个活跃 Agent 长任务”的现有语义，同时向更通用模型扩展：

- Agent 流式任务使用 `concurrency_key = session:{session_id}`
- Node 执行首轮默认不做全局互斥，可按请求需要扩展
- MCP 连接操作可使用 `concurrency_key = mcp:server:{server_name}`
- MCP 工具调用首轮不强制互斥，但应有独立 task_id

这意味着 `TaskRegistry` 需要从“session 唯一任务”升级为“task 主索引 + 并发键索引”，同时保留旧查询接口。

### 6.6 取消语义

P3 第一阶段统一采用**协作式取消**：

- `ExecutionService.cancel(task_id | session_id)` 只负责：
  - 标记 `cancel_requested`
  - `cancel_event.set()`
  - 唤醒审批/输入等待
  - 可选发布取消事件
- 具体执行体在合适位置检查 `cancel_event` 后自行退出。

不同执行类型的第一阶段语义：

- Agent：已有 `_check_interrupt()`，可以直接复用。
- Node：首轮仅包装层支持 cancel 标记；具体 Node 是否中断取决于其内部是否可协作检查。
- MCP：首轮 cancel 主要作用于“上层不再等待 + 状态收口”，不承诺立刻中断底层 SDK 调用。

### 6.7 超时语义

P3 第一阶段统一采用**执行层记录超时 + 底层 best-effort 停止**：

- 到达 `timeout_seconds` 后：
  - 状态进入 `timed_out`
  - 设置 `cancel_event`
  - 返回超时结果给调用方
- 对于底层不能被立即打断的执行体，视为“逻辑超时已发生，物理执行可能仍在收尾”。

这与当前 MCP `future.result(timeout=...)` 的行为更接近，但执行层需要把这个语义显式制度化，而不是留在各模块各自实现。

### 6.8 事件语义

P3 第一阶段不建议新起一整套 execution event family。建议复用现有 Agent 事件模型中的通用生命周期事件：

- `RUN_START`
- `RUN_END`
- `ERROR`
- 必要时继续复用 `USER_INTERRUPT`

并在 `event.data` 中补齐统一字段：

- `task_id`
- `execution_kind`
- `run_id`
- `status`
- `timeout_seconds`

这样可以最大化复用：

- 会话事件总线
- SSE 转发
- 历史回放
- 前端现有消费链路

## 7. Adapter 设计

P3 第一阶段不要求把所有执行逻辑抽成一个大而全 base class，但建议按执行类型拆 adapter。

### 7.1 `AgentExecutionAdapter`

职责：

- 吸收当前 `stream_run.py` 和 `stream_helpers.py` 中属于执行控制的部分。
- 创建/装配 `AgentContext`、`run_id`、`cancel_event`。
- 注册消息持久化、run_steps、压缩摘要等订阅。
- 调用 `master_agent.execute(...)`。
- 结束时统一写回状态并清理订阅。

保留在 adapter 内而不下沉到通用层的职责：

- conversation store 写入
- run_steps 结构
- final answer 持久化
- Agent 专属事件与消息落库

### 7.2 `NodeExecutionAdapter`

职责：

- 包装 `NodeService.execute_node(...)` 的统一执行入口。
- 在不改变 Node 业务逻辑的前提下，补上：
  - task_id
  - timeout
  - cancel token
  - 状态记录

第一阶段注意点：

- 不修改 `INode.execute()` 签名。
- 不要求所有 Node 立刻支持中途取消。
- 首轮主要目标是把“Route 直接执行”改成“Route -> ExecutionService.run(...) -> NodeExecutionAdapter”。

### 7.3 `MCPExecutionAdapter`

职责：

- 为 MCP 的 connect / disconnect / test / call_tool 提供统一执行包装。
- 把 `MCPClientManager` 重新定位为 integration manager，而不是执行平面对外入口。
- 在 adapter 层补齐：
  - task_id
  - timeout 统一配置
  - 状态写回
  - 可选事件发布

第一阶段注意点：

- 不重写 `MCPClientManager` 内部 loop。
- 不强求 MCP SDK 调用立刻支持硬取消。
- 先把外层入口统一，再逐步优化内部取消能力。

## 8. 建议模块拆分

建议新增以下模块：

- `backend/services/execution_service.py`
  - `ExecutionService`
- `backend/execution/models.py`
  - `ExecutionRequest`
  - `ExecutionContext`
  - `ExecutionHandle`
  - `ExecutionResult`
- `backend/execution/in_process_runner.py`
  - `InProcessExecutionRunner`
- `backend/execution/adapters/agent_execution.py`
  - `AgentExecutionAdapter`
- `backend/execution/adapters/node_execution.py`
  - `NodeExecutionAdapter`
- `backend/execution/adapters/mcp_execution.py`
  - `MCPExecutionAdapter`

同时建议对以下现有模块做最小扩展：

- `backend/runtime/container.py`
  - 新增 `get_execution_service()`
  - 必要时新增 `get_in_process_execution_runner()`
- `backend/agents/task_registry.py`
  - 向 task-aware registry 演进，但保留 session 兼容接口

## 9. 推荐实施顺序

### 阶段 1：搭执行层壳子

- 新增 `ExecutionService`、执行模型、进程内 runner。
- 将其接入 `RuntimeContainer`。
- 不立即改 Route 行为。

### 阶段 2：扩 `TaskRegistry`

- 加入 `task_id` 和更完整状态集。
- 引入并发键索引。
- 保留 `get_status(session_id)` / `cancel(session_id)` 兼容接口。

### 阶段 3：接管 Agent 流式任务

- 将 Route 中的线程管理迁到 `AgentExecutionAdapter`。
- `stream_run.py` 保留请求解析和 SSE 输出。
- `/stream/stop` 和状态查询改调 `ExecutionService`。

### 阶段 4：接管 Node 执行

- `routes/nodes.py` 改调 `ExecutionService.run(...)`。
- `NodeService` 保持业务逻辑主体不动。

### 阶段 5：接管 MCP 执行入口

- `MCPService` 的 connect/test/refresh/call_tool 统一经过 `ExecutionService`。
- Agent 内部 `mcp__*` 工具调用改走同一入口。

## 10. 本阶段明确先不要动的地方

以下内容建议在 P3 第一阶段明确保持不动：

### 10.1 不重写 `MCPClientManager`

理由：

- 当前其 loop 模型虽重，但已经稳定承担进程内桥接角色。
- 第一阶段的核心问题是“入口不统一”，不是“loop 实现不对”。

### 10.2 不批量改 Node 接口签名

理由：

- 修改 `INode.execute()` 会波及所有节点实现。
- 第一阶段优先解决入口、状态和取消模型，不急于侵入所有 Node。

### 10.3 不动现有 SSE / 重连协议

理由：

- 当前 Agent 流的前端消费链和事件回放链已经较成熟。
- 通知平面不是当前主要瓶颈。

### 10.4 不合并两套审批/输入等待机制

理由：

- 当前 `EventBus` 与 `TaskRegistry` 各自都有等待模型。
- 这是另一条独立重构线，不应混入 P3 首刀。

## 11. 第一阶段验收标准

P3 第一阶段完成后，应至少满足以下结果：

- Route 不再直接起线程。
- Agent 流式任务通过统一执行入口发起。
- Node 执行接入统一执行入口，即便仍为同步执行。
- MCP 外部入口通过统一执行服务包装。
- 取消与超时具备统一状态语义：`cancel_requested` / `interrupted` / `timed_out`。
- `RuntimeContainer` 成为执行层唯一装配入口。
- 现有会话事件总线、SSE、重连协议保持兼容。

## 12. 风险与后续议题

### 12.1 已知风险

- Node 和 MCP 的“物理取消”能力在第一阶段仍然有限。
- `TaskRegistry` 的兼容改造需要谨慎，避免破坏现有 Agent 审批/输入等待链路。
- Agent 线程包装层与内部 `run_end(status=...)` 需要统一最终状态归一规则。

### 12.2 建议在 P3 之后继续评估的议题

- 是否需要单独的 execution event 类型。
- 是否需要把 `TaskRegistry` 最终演进为更通用的 execution registry。
- 是否需要给长耗时 Node 增加 opt-in 的 `ExecutionContext` / cancel hook。
- 是否需要让 `MCPClientManager` 暴露可取消 future handle。
- 是否需要在 P4 中补统一的 `task_id` / `run_id` / `session_id` 全链路观测字段。

### 12.3 P4 首步落地（execution observability context）

P4 的第一步已经按“轻量、兼容、复用 execution layer”落地，目标不是重写协议，而是把现有执行平面变成可追踪的统一观测链路。

本轮落地原则：

- 以 `ExecutionService` 为唯一规范化入口。
- 不引入 tracing 平台、消息队列等新基础设施。
- 不重写现有 SSE 协议，仅附加兼容字段。
- 不改变前端调用方式，优先在后端补齐默认值与继承语义。

本轮统一字段：

- `task_id`
- `session_id`
- `run_id`
- `execution_kind`
- `request_id`（可选；HTTP 入口有则透传，无则生成）

落地要点：

- 新增 `ExecutionObservabilityContext`，并通过 `contextvars` 在 execution 线程内自动绑定。
- `ExecutionService.build_context(...)` 统一规范化字段来源：显式传入 > 当前 execution 上下文继承 > execution layer 默认兜底。
- `TaskRegistry` 状态快照补充 `request_id`，使重连/状态查询可返回同一组观测字段。
- Agent SSE、事件总线、run_steps 在保持兼容的前提下，统一附带 execution 字段。
- Node 与 MCP 不共享 Agent 语义，但共享 execution observability 语义。

实现位置：

- `backend/execution/observability.py`
- `backend/services/execution_service.py`
- `backend/execution/in_process_runner.py`
- `backend/execution/adapters/agent_execution.py`
- `backend/routes/agent_api/stream_run.py`
- `backend/routes/agent_api/stream_control.py`
- `backend/execution/adapters/node_execution.py`
- `backend/execution/adapters/mcp_execution.py`
- `backend/services/mcp_service.py`
- `backend/mcp/client_manager.py`

## 13. 最终建议

P3 的正确切法不是直接“大重构执行系统”，而是：

1. 先建立一个轻量、进程内、可装配的 `ExecutionService`；
2. 先把 Route 和 Manager 手里的执行控制权收回来；
3. 先让 Agent / Node / MCP 共享一套最小状态、取消、超时语义；
4. 再决定后面是否需要更重的执行基础设施。

这个顺序最贴合当前仓库结构，也能最大化复用现有 `TaskRegistry`、事件总线、SSE 和 `RuntimeContainer` 资产。
