# 执行平面当前核对清单

本文档用于核对执行平面的当前事实与开发约束，不记录历史阶段。

关联文档：

- `docs/P3_EXECUTION_LAYER_DESIGN.md`
- `docs/P4_OBSERVABILITY_ROUTES.md`
- `docs/ARCHITECTURE_BOUNDARIES.md`

## 1. 装配与入口

- [x] `RuntimeContainer` 可返回 `ExecutionService`
- [x] `RuntimeContainer` 可返回 `InProcessExecutionRunner`
- [x] `ExecutionService` 是当前统一 execution 入口
- [x] `ExecutionService` 提供 submit/run/cancel/status/diagnostics/overview 能力
- [x] `TaskRegistry` 与 `SessionEventBusManager` 由 execution layer 复用

## 2. Agent

- [x] `/api/agent/stream` 通过 `AgentExecutionAdapter` 发起执行
- [x] Agent 流式任务不由 Route 直接起线程
- [x] `/api/agent/stream/stop` 通过 `ExecutionService.cancel_session(...)` 停止任务
- [x] `/api/agent/stream/reconnect` 通过 session event bus 回放历史并继续订阅
- [x] Agent SSE payload 顶层补充 execution observability 字段

## 3. Node

- [x] `/api/nodes/execute` 通过 `NodeExecutionAdapter` 接入 execution layer
- [x] Node 执行支持透传 `session_id`
- [x] Node 执行支持透传 `run_id`
- [x] Node 执行支持透传 `request_id`
- [x] Node timeout 通过 execution layer 统一包装

## 4. MCP

- [x] `MCPService` 通过 `MCPExecutionAdapter` 触发 connect
- [x] `MCPService` 通过 `MCPExecutionAdapter` 触发 disconnect
- [x] `MCPService` 通过 `MCPExecutionAdapter` 触发 refresh
- [x] `MCPService` 通过 `MCPExecutionAdapter` 触发 test
- [x] `MCPService` 通过 `MCPExecutionAdapter` 触发 `call_tool`

## 5. 状态与控制语义

- [x] 状态集中包含 `starting`
- [x] 状态集中包含 `running`
- [x] 状态集中包含 `cancel_requested`
- [x] 状态集中包含 `completed`
- [x] 状态集中包含 `failed`
- [x] 状态集中包含 `interrupted`
- [x] 状态集中包含 `timed_out`
- [x] `ExecutionService` 支持按 `task_id` 查询状态
- [x] `ExecutionService` 支持按 `session_id` 查询状态
- [x] `ExecutionService` 支持按 `session_id` 取消当前任务

## 6. Observability

- [x] execution context 统一包含 `task_id`
- [x] execution context 统一包含 `session_id`
- [x] execution context 统一包含 `run_id`
- [x] execution context 统一包含 `execution_kind`
- [x] execution context 统一包含 `request_id`
- [x] status snapshot 返回 `request_id`
- [x] diagnostics snapshot 返回标准 observability 字段
- [x] Agent reconnect 事件返回 observability 字段

## 7. 查询接口

- [x] `GET /api/agent/sessions/<session_id>/task-status`
- [x] `GET /api/agent/sessions/<session_id>/execution-diagnostics`
- [x] `GET /api/agent/tasks/<task_id>/status`
- [x] `GET /api/agent/tasks/<task_id>/execution-diagnostics`
- [x] `GET /api/agent/tasks/running`
- [x] `GET /api/agent/execution/overview`

## 8. 当前测试锚点

建议把以下测试视为当前执行平面的事实校验：

- `backend/tests/execution_service_test.py`
- `backend/tests/runtime_execution_plane_test.py`
- `backend/tests/agent_execution_adapter_test.py`
- `backend/tests/node_execution_adapter_test.py`
- `backend/tests/mcp_execution_adapter_test.py`
- `backend/tests/route_observability_contract_test.py`

## 9. 后续开发核对项

新增执行相关功能时，至少确认以下几点：

- [ ] 是否复用了 `ExecutionService`，而不是在 Route 中直接编排执行控制
- [ ] 是否补齐了 `task_id/run_id/request_id`
- [ ] 是否定义了清晰的 timeout 语义
- [ ] 是否定义了取消后的最终状态
- [ ] 是否需要进入 session event bus / SSE 链路
- [ ] 是否需要补 contract test 或 adapter test
