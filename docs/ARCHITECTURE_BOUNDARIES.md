# 架构边界

本文档用于描述仓库当前应遵守的边界规则和开发方向，只写当前实现与当前约束。

## 1. 当前分层

推荐依赖方向：

`routes -> services -> execution/domain -> integrations/infrastructure`

各层职责：

- `routes`
  - 协议适配
  - 参数提取
  - 状态码与响应 envelope
- `services`
  - 业务用例编排
  - 对下游模块做稳定组合
- `execution`
  - 统一执行入口
  - 状态、取消、超时、diagnostics、overview
- `integrations/infrastructure`
  - 第三方 SDK
  - 文件系统
  - 网络与外部协议

当前系统还不是严格的 ports 架构，但以上依赖方向已经是主约束。

## 2. Route 边界

Route 层应遵守：

- 不直接创建线程
- 不直接维护任务状态注册表
- 不直接处理第三方 SDK
- 不直接操作 YAML 文件存储
- 不直接创建运行时核心单例

Route 层当前允许：

- 调用 service
- 调用 execution adapter
- 调用 `success_response(...)` / `error_response(...)`
- 流式场景下装配 SSE Response

## 3. Runtime 边界

当前运行时入口是 `backend/runtime/container.py`。

开发要求：

- 新增运行时核心对象优先挂到 `RuntimeContainer`
- 需要兼容 fallback 时统一复用 `runtime.dependencies`
- 不在新模块中复制旧式包级 getter + 全局单例模式

辅助检查：

- `backend/scripts/runtime_strict_audit.py`
- `backend/tests/runtime_dependencies_test.py`
- `backend/tests/runtime_strict_audit_test.py`

## 4. 配置与存储边界

当前 YAML 文件语义以共享 helper 为准：

- `backend/utils/yaml_store.py`
- `backend/utils/versioned_yaml_store.py`
- `backend/utils/file_lock.py`

开发要求：

- 新的 YAML store 复用共享读写 helper
- 原子写入、备份、文件锁语义不应在业务模块里重复实现
- 测试优先使用仓库内临时目录，不依赖受限系统 Temp

辅助检查：

- `backend/tests/storage_refactor_guards_test.py`
- `backend/tests/yaml_store_test.py`
- `backend/tests/versioned_yaml_store_test.py`
- `backend/tests/file_lock_test.py`

## 5. 执行平面边界

当前执行平面事实：

- `ExecutionService` 是统一执行入口
- Agent 流式执行通过 `AgentExecutionAdapter`
- Node 执行通过 `NodeExecutionAdapter`
- MCP connect/test/call 通过 `MCPExecutionAdapter`
- session event bus 与 SSE 仍是通知层，不替代 execution layer

开发要求：

- 新的长耗时执行链路优先接入 `ExecutionService`
- 取消与超时语义需要落到统一状态集
- 需要查询运行中状态的能力时，应复用 status/diagnostics/overview 查询面

辅助文档：

- `docs/P3_EXECUTION_LAYER_DESIGN.md`
- `docs/P3_EXECUTION_LAYER_CHECKLIST.md`
- `docs/P4_OBSERVABILITY_ROUTES.md`

辅助检查：

- `backend/tests/execution_service_test.py`
- `backend/tests/runtime_execution_plane_test.py`
- `backend/tests/route_observability_contract_test.py`

## 6. Observability 边界

当前 execution canonical 字段：

- `task_id`
- `session_id`
- `run_id`
- `execution_kind`
- `request_id`

开发要求：

- 新执行链路需要明确这些字段的来源
- HTTP 入口应提取或生成 `request_id`
- 需要跨线程透传时应复用 execution observability context
- SSE 与非流式查询接口的字段命名保持一致

## 7. 前端边界

当前职责划分：

- `frontend`
  - 管理控制台
  - 配置、节点、工作流、文件、图谱、向量、模型、MCP 页面
- `frontend-client`
  - 聊天
  - 执行监控
  - Agent 配置与 MCP 的轻量操作入口

开发要求：

- 新页面先明确属于哪个前端
- 同一后端资源若被两个前端同时消费，应优先统一 API 契约
- 页面共存可以接受，但职责必须明确

## 8. 当前开发方向

以下方向属于当前开发主题，但不应改变上面的边界约束：

- 继续收紧 runtime fallback
- 继续完善 execution observability
- 为关键路由补 contract test
- 为配置与执行层补更多静态守卫和回归测试
