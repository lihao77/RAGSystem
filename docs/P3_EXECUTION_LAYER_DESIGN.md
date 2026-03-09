# 执行平面当前实现

本文档只描述仓库当前使用的进程内执行平面，不记录历史改造阶段。

关联文档：

- `docs/ARCHITECTURE_BOUNDARIES.md`
- `docs/P3_EXECUTION_LAYER_CHECKLIST.md`
- `docs/P4_OBSERVABILITY_ROUTES.md`

## 1. 目标

当前执行平面的职责是统一以下能力：

- 执行入口
- 状态管理
- 取消与超时语义
- 运行中任务查询
- execution observability 字段透传

当前实现仍然是进程内方案，不引入独立 worker、消息队列或外部调度器。

## 2. 核心组件

### 2.1 RuntimeContainer

`backend/runtime/container.py`

当前容器负责装配执行平面相关对象：

- `ExecutionService`
- `InProcessExecutionRunner`
- `TaskRegistry`
- `SessionEventBusManager`
- `MCPExecutionAdapter`
- `MCPService`

`RuntimeContainer` 是执行平面的首选装配入口。

### 2.2 ExecutionService

`backend/services/execution_service.py`

这是执行平面的统一入口。当前提供的核心能力：

- `build_context(...)`
- `submit(...)`
- `run(...)`
- `cancel(...)`
- `cancel_session(...)`
- `get_status(...)`
- `get_status_by_session(...)`
- `get_diagnostics(...)`
- `get_diagnostics_by_session(...)`
- `list_statuses(...)`
- `list_diagnostics(...)`
- `get_overview(...)`
- `cleanup_finished(...)`

### 2.3 InProcessExecutionRunner

`backend/execution/in_process_runner.py`

当前 runner 负责：

- 在线程内执行 target
- 管理 `ExecutionHandle`
- 处理 join / timeout
- 与 execution observability context 对接

### 2.4 TaskRegistry

`backend/agents/task_registry.py`

当前注册表承担以下职责：

- `task_id` 主索引
- session 兼容查询
- 并发占位
- 取消信号记录
- 审批/输入等待相关状态
- 任务快照输出

### 2.5 执行适配器

当前有三个适配器：

- `backend/execution/adapters/agent_execution.py`
- `backend/execution/adapters/node_execution.py`
- `backend/execution/adapters/mcp_execution.py`

它们负责把各子系统接入统一 execution layer，而不要求业务逻辑本身合并到同一模块。

## 3. 当前调用链

### 3.1 Agent 流式执行

入口文件：

- `backend/routes/agent_api/stream_run.py`
- `backend/routes/agent_api/stream_control.py`
- `backend/routes/agent_api/execution_sync.py`

当前链路：

1. `stream_run.py` 解析 HTTP 请求与 `selected_llm`
2. `AgentExecutionAdapter.start_stream_execution(...)` 创建 `AgentContext`、`cancel_event`、`SSEAdapter`
3. 适配器先在 `TaskRegistry` 中注册任务，再调用 `ExecutionService.submit(...)`
4. `ExecutionService` 通过 `InProcessExecutionRunner` 在线程内执行 Agent target
5. Agent 事件写入 session event bus，由 `SSEAdapter` 输出给前端
6. `execution_sync.py` 和 `stream_control.py` 提供 stop、status、diagnostics、reconnect 等查询/控制接口

当前事实：

- Route 不直接创建线程
- Agent 长任务通过 `ExecutionService` 发起
- SSE 与事件回放仍然由 session event bus + `SSEAdapter` 承担

### 3.2 Node 执行

入口文件：

- `backend/routes/nodes.py`
- `backend/execution/adapters/node_execution.py`

当前链路：

1. `routes/nodes.py` 接收请求并提取 `session_id/run_id/request_id`
2. `NodeExecutionAdapter.execute(...)` 构造 `ExecutionRequest`
3. 适配器调用 `ExecutionService.run(...)`
4. target 内部仍然调用 `NodeService.execute_node(...)`
5. 执行结果再由适配器统一解包为 HTTP 层可消费的结果或异常

当前事实：

- Node 执行已接入统一执行入口
- Node 内核接口没有被大规模改签名
- timeout 语义由 execution layer 包装，Node 是否支持物理中断仍取决于具体实现

### 3.3 MCP 执行

入口文件：

- `backend/services/mcp_service.py`
- `backend/execution/adapters/mcp_execution.py`
- `backend/mcp/client_manager.py`

当前链路：

1. `MCPService` 负责 HTTP/API 侧业务编排
2. `MCPExecutionAdapter` 为 connect/disconnect/refresh/test/call_tool 构造 `ExecutionRequest`
3. 适配器调用 `ExecutionService.run(...)`
4. 真正的连接管理与 SDK 桥接仍由 `MCPClientManager` 处理

当前事实：

- MCP 对外执行入口已统一经过 execution layer
- `MCPClientManager` 仍保留内部 event loop 模型
- cancel/timeout 仍以 best-effort 为主，不承诺硬中断底层 SDK 调用

## 4. 统一状态语义

当前执行层使用以下状态：

- `starting`
- `running`
- `cancel_requested`
- `completed`
- `failed`
- `interrupted`
- `timed_out`

这些状态由 `ExecutionService`、`TaskRegistry`、adapter 返回值共同驱动。

## 5. 取消与超时

### 5.1 取消

当前取消入口：

- `ExecutionService.cancel(task_id)`
- `ExecutionService.cancel_session(session_id, ...)`

当前行为：

- 设置 `cancel_event`
- 更新任务状态
- session 场景下可发布 `USER_INTERRUPT`
- 最终是否及时退出由具体执行体协作完成

### 5.2 超时

当前超时语义：

- 由 `ExecutionRequest.timeout_seconds` 驱动
- runner 和 `ExecutionHandle` 负责等待与结果同步
- 结果统一映射到 `timed_out`

当前边界：

- 逻辑超时已经统一
- 物理中断能力在 Node/MCP 场景下仍然有限

## 6. 通知层与执行层分工

当前系统明确保留两层职责：

### 6.1 Execution layer

负责：

- 提交执行
- 创建上下文
- 管理状态
- 管理 handle
- 查询 diagnostics / overview

### 6.2 Notification layer

负责：

- session event bus
- SSE 输出
- 事件历史回放
- reconnect

相关模块：

- `backend/agents/events/bus.py`
- `backend/agents/events/session_manager.py`
- `backend/routes/agent_api/stream_helpers.py`
- `backend/routes/agent_api/stream_control.py`

## 7. Execution Observability

execution canonical 字段为：

- `task_id`
- `session_id`
- `run_id`
- `execution_kind`
- `request_id`

当前实现位置：

- `backend/execution/observability.py`
- `backend/services/execution_service.py`
- `backend/routes/agent_api/stream_run.py`
- `backend/routes/agent_api/stream_control.py`
- `backend/routes/agent_api/execution_sync.py`
- `backend/execution/adapters/node_execution.py`
- `backend/execution/adapters/mcp_execution.py`

查询接口与响应契约见 `docs/P4_OBSERVABILITY_ROUTES.md`。

## 8. 当前边界

以下内容不属于当前执行平面的职责：

- 不提供跨进程调度
- 不提供分布式队列
- 不统一重写 Node 内部执行模型
- 不重写 `MCPClientManager` 内部 loop
- 不替代 session event bus / SSE

## 9. 开发要求

后续开发应遵守以下规则：

- 新的长耗时执行入口优先接入 `ExecutionService`
- Route 不直接创建线程
- Route 不直接维护执行状态快照
- 需要 `task_id/run_id/request_id` 的链路，应通过 execution context 或 `ExecutionRequest` 透传
- 需要 session 重连的链路，应继续复用 session event bus 与 `SSEAdapter`
