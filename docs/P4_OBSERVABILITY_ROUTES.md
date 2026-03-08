# P4 Execution Observability Routes

状态：P4 第一阶段已落地（查询面 / diagnostics / overview）

关联文档：

- `docs/ARCHITECTURE_BOUNDARIES.md`
- `docs/P3_EXECUTION_LAYER_DESIGN.md`
- `docs/P3_EXECUTION_LAYER_CHECKLIST.md`

## 1. 目标

本文件用于集中说明 P4 第一阶段已经落地的 execution observability 查询接口、统一字段和响应契约。

这一阶段的目标不是重写执行协议，而是：

- 让 `Agent` / `Node` / `MCP` 共享统一 execution 观测字段
- 让状态查询、排障查询、运行概览有稳定的 HTTP 查询面
- 让前端监控页或运维脚本不再依赖 SSE 文本或零散日志做推断

## 2. 统一字段

以下字段为 execution plane 的 canonical observability fields：

- `task_id`
- `session_id`
- `run_id`
- `execution_kind`
- `request_id`

约束说明：

- `task_id`：execution layer 内部的主键
- `session_id`：会话型任务可用；Node/MCP 允许为空
- `run_id`：同一轮执行链路的聚合标识
- `execution_kind`：如 `agent_stream` / `node_execute` / `mcp_tool_call`
- `request_id`：HTTP 入口提取或生成，仅用于观测与排障，不参与业务语义

## 3. 响应契约

### 3.1 状态查询类

状态查询接口统一返回以下兼容字段：

- `found`
- `scope`
- `scope_id`
- `task_info`
- `observability`

其中：

- `scope` 表示本次查询维度，目前为 `session_id` 或 `task_id`
- `scope_id` 表示对应的查询值
- `task_info` 为 `TaskRegistry` 统一状态快照
- `observability` 为从 `task_info` 或 diagnostics 中提取出的标准观测字段

### 3.2 Diagnostics 查询类

diagnostics 接口统一返回：

- `found`
- `scope`
- `scope_id`
- `diagnostics`

其中 `diagnostics` 结构为：

- `task`：registry 视角状态快照
- `runner`：runner 视角快照（如果当前 handle 仍存在）
- `observability`：标准 execution 字段
- `handle_registered`：execution service 是否仍持有 handle
- `is_running`：是否为运行中任务

### 3.3 列表 / 概览类

列表或聚合接口统一使用：

- `count`
- `items`

如果存在过滤条件，应显式返回：

- `active_only`

概览接口额外返回：

- `by_execution_kind`
- `by_status`
- `sessions`

## 4. 路由列表

### 4.1 Session 维度

#### `GET /api/agent/sessions/<session_id>/task-status`

用途：

- 查询某个会话当前是否存在运行中任务
- 页面刷新后恢复 loading 状态
- 前端直接拿 `observability` 字段继续做 task 级查询

响应要点：

- `found`
- `has_running_task`
- `task_info`
- `observability`

#### `GET /api/agent/sessions/<session_id>/execution-diagnostics`

用途：

- 按 session 查看 execution diagnostics
- 排查 registry 与 runner 是否一致

响应要点：

- `found`
- `scope=session_id`
- `scope_id=<session_id>`
- `diagnostics`

### 4.2 Task 维度

#### `GET /api/agent/tasks/<task_id>/status`

用途：

- 已拿到 `task_id` 后查询统一状态快照
- 适合由 SSE、日志或上层控制面回查任务状态

响应要点：

- `found`
- `scope=task_id`
- `scope_id=<task_id>`
- `task_info`
- `observability`

#### `GET /api/agent/tasks/<task_id>/execution-diagnostics`

用途：

- 查看单个任务更完整的 diagnostics 视图

响应要点：

- `found`
- `scope=task_id`
- `scope_id=<task_id>`
- `diagnostics`

### 4.3 列表 / 概览维度

#### `GET /api/agent/tasks/running`

用途：

- 获取当前全部运行中任务
- 适合监控页轮询、刷新恢复、排障面板列表

响应要点：

- `active_only=true`
- `count`
- `items`

#### `GET /api/agent/execution/overview?active_only=true`

用途：

- 获取 execution plane 聚合摘要
- 适合监控概览卡片、分组统计、运行中会话概览

参数：

- `active_only`：默认 `true`
  - `true`：只看活跃任务
  - `false`：返回全部任务快照

响应要点：

- `active_only`
- `count`
- `by_execution_kind`
- `by_status`
- `sessions`
- `items`

## 5. 建议使用方式

### 5.1 前端对话页

推荐链路：

1. 通过 `/api/agent/stream` 发起执行
2. 从 SSE 的附加字段中拿到 `task_id/run_id/request_id`
3. 刷新后先调用 `/api/agent/sessions/<session_id>/task-status`
4. 若需要排障或补充上下文，再调用 `/execution-diagnostics`

### 5.2 监控页 / 运维页

推荐链路：

1. 首页轮询 `/api/agent/execution/overview`
2. 需要列表时调用 `/api/agent/tasks/running`
3. 点击单条任务时调用 `/api/agent/tasks/<task_id>/status`
4. 需要深挖时调用 `/api/agent/tasks/<task_id>/execution-diagnostics`

## 6. 当前边界

本阶段刻意保持以下边界：

- 不重写 SSE 协议
- 不引入 tracing 平台
- 不改前端原有调用方式
- 不要求 Node / MCP 具备 Agent 会话语义

也就是说：

- `Node` / `MCP` 共享 execution observability 语义
- 但它们不因此变成 Agent 子系统的一部分

## 7. 后续建议

P4 下一阶段可优先考虑：

- 将更多 `services/`、`tools/`、`integrations/` 日志接到 execution context
- 为这些查询接口补更正式的 API contract tests
- 在前端监控页中直接消费 `/tasks/running` 与 `/execution/overview`
