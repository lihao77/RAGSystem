# P3 执行平面实施清单

状态：Phase 1-7 已完成  
日期：2026-03-08  
关联文档：`docs/P3_EXECUTION_LAYER_DESIGN.md`

## 1. 使用方式

本清单用于把 `docs/P3_EXECUTION_LAYER_DESIGN.md` 拆成可执行的实施阶段。

建议推进方式：

- 按阶段推进，不跨阶段大范围并行改造。
- 每一阶段尽量形成一个可独立评审、可独立回滚的 PR。
- 只有当前阶段的“完成定义”满足后，再进入下一阶段。
- 除非清单明确要求，否则不要顺手做额外大改。

## 2. 总体推进顺序

- [ ] Phase 0：补齐执行层骨架设计落点与命名收口
- [x] Phase 1：新增最小 execution layer 骨架
- [x] Phase 2：扩展 `TaskRegistry` 为 task-aware registry
- [x] Phase 3：接管 Agent 流式执行入口
- [x] Phase 4：收口 Agent 控制接口与状态接口
- [x] Phase 5：接管 Node 执行入口
- [x] Phase 6：接管 MCP 执行入口
- [ ] Phase 7：补齐测试、守卫和收尾文档

---

## 3. Phase 0：命名与落点确认

### 目标

先把执行层的文件位置、类名、容器入口定下来，避免边做边改命名。

### 待办

- [ ] 确认执行层目录为 `backend/execution/`
- [ ] 确认统一入口类名为 `ExecutionService`
- [ ] 确认进程内 runner 类名为 `InProcessExecutionRunner`
- [ ] 确认 adapter 目录为 `backend/execution/adapters/`
- [ ] 确认首批 adapter 命名：
  - [ ] `AgentExecutionAdapter`
  - [ ] `NodeExecutionAdapter`
  - [ ] `MCPExecutionAdapter`
- [ ] 确认 `RuntimeContainer` 新 getter 命名：
  - [ ] `get_execution_service()`
  - [ ] 如有必要，`get_in_process_execution_runner()`

### 涉及文件

- [ ] `docs/P3_EXECUTION_LAYER_DESIGN.md`
- [ ] `backend/runtime/container.py`

### 完成定义

- [ ] 后续各阶段使用统一命名，不再反复变更
- [ ] 目录与类名足够稳定，可以开始落代码骨架

---

## 4. Phase 1：新增最小 execution layer 骨架

### 目标

先把执行层“壳子”搭起来，但暂时不接管任何 Route。

### 待办

#### 4.1 新增模型

- [ ] 创建 `backend/execution/models.py`
- [ ] 定义 `ExecutionRequest`
- [ ] 定义 `ExecutionContext`
- [ ] 定义 `ExecutionHandle`
- [ ] 定义 `ExecutionResult`
- [ ] 为上述模型补最小字段：
  - [ ] `task_id`
  - [ ] `execution_kind`
  - [ ] `session_id`
  - [ ] `run_id`
  - [ ] `concurrency_key`
  - [ ] `timeout_seconds`
  - [ ] `metadata`
  - [ ] `cancel_event`

#### 4.2 新增进程内 runner

- [ ] 创建 `backend/execution/in_process_runner.py`
- [ ] 实现 `InProcessExecutionRunner`
- [ ] 明确 runner 只负责：
  - [ ] 起线程
  - [ ] 保存 thread handle
  - [ ] 等待完成
  - [ ] best-effort cancel
  - [ ] 统一 timeout 包装
- [ ] 不在 runner 中放业务逻辑

#### 4.3 新增统一 service

- [ ] 创建 `backend/services/execution_service.py`
- [ ] 实现 `ExecutionService`
- [ ] 增加统一入口：
  - [ ] `submit(...)`
  - [ ] `run(...)`
  - [ ] `cancel(...)`
  - [ ] `get_status(...)`
- [ ] 让 `ExecutionService` 接收以下依赖：
  - [ ] `TaskRegistry`
  - [ ] `SessionEventBusManager`
  - [ ] runner
- [ ] 保持 service 不直接依赖 Flask request/response

#### 4.4 接入 runtime container

- [ ] 在 `backend/runtime/container.py` 中新增 `get_execution_service()`
- [ ] 如需要，新增 `get_in_process_execution_runner()`
- [ ] 保证 `ExecutionService` 通过容器装配
- [ ] 不新增新的包级全局单例

### 涉及文件

- [ ] `backend/execution/models.py`
- [ ] `backend/execution/in_process_runner.py`
- [ ] `backend/services/execution_service.py`
- [ ] `backend/runtime/container.py`

### 建议测试

- [ ] 新增 execution service 基本单测
- [ ] 验证 `RuntimeContainer` 能返回同一 `ExecutionService` 实例
- [ ] 验证在 strict runtime 模式下无额外 fallback

### 完成定义

- [ ] 执行层骨架可被容器获取
- [ ] 还未接管业务路由，但接口和依赖方向已固定

---

## 5. Phase 2：扩展 `TaskRegistry`

### 目标

把当前偏向 Agent session 的注册表，扩成可被执行层复用的 task-aware registry。

### 待办

#### 5.1 扩 task 模型

- [ ] 为 `TaskInfo` 增加 `task_id`
- [ ] 为 `TaskInfo` 增加 `execution_kind`
- [ ] 为 `TaskInfo` 增加 `concurrency_key`
- [ ] 为 `TaskInfo` 增加 `timeout_seconds`
- [ ] 为 `TaskInfo` 增加更完整状态值支持：
  - [ ] `starting`
  - [ ] `running`
  - [ ] `cancel_requested`
  - [ ] `completed`
  - [ ] `failed`
  - [ ] `interrupted`
  - [ ] `timed_out`

#### 5.2 扩索引与查询

- [ ] 保留 session 兼容索引
- [ ] 增加 `task_id` 主索引
- [ ] 增加 `concurrency_key` 活跃索引
- [ ] 增加按 `task_id` 查询状态的方法
- [ ] 保留 `get_status(session_id)` 兼容接口
- [ ] 保留 `cancel(session_id)` 兼容接口
- [ ] 新增按 `task_id` 的取消接口

#### 5.3 调整状态迁移

- [ ] 支持 “预占位 -> starting -> running”
- [ ] 支持 “cancel_requested -> interrupted/failed/timed_out”
- [ ] 避免当前“线程已起但未登记”的窗口
- [ ] 明确 cleanup 时机，不破坏现有审批/输入等待链路

#### 5.4 兼容 Agent 现有能力

- [ ] 兼容持久化订阅清理
- [ ] 兼容待审批请求
- [ ] 兼容待用户输入请求
- [ ] 不破坏 `stream_control.py` 当前行为

### 涉及文件

- [ ] `backend/agents/task_registry.py`
- [ ] `backend/routes/agent_api/stream_control.py`
- [ ] `backend/routes/agent_api/execution_sync.py`
- [ ] 其他依赖 `get_task_registry()` 的调用点

### 建议测试

- [ ] 任务按 `task_id` 注册/查询/取消测试
- [ ] `concurrency_key` 并发占用测试
- [ ] session 兼容接口回归测试
- [ ] 审批/输入等待链路回归测试

### 完成定义

- [ ] `TaskRegistry` 同时支持 task 语义和 session 兼容语义
- [ ] 执行层可以基于它做统一占位和状态控制

---

## 6. Phase 3：接管 Agent 流式执行入口

### 目标

让 `stream_run` 不再直接创建后台线程，把 Agent 长任务生命周期收口到 `ExecutionService + AgentExecutionAdapter`。

### 待办

#### 6.1 新增 Agent adapter

- [ ] 创建 `backend/execution/adapters/agent_execution.py`
- [ ] 实现 `AgentExecutionAdapter`
- [ ] 将下列逻辑从 Route / helper 迁入 adapter：
  - [ ] `AgentContext` 装配
  - [ ] `run_id` 初始化
  - [ ] `cancel_event` 注入
  - [ ] 持久化订阅注册
  - [ ] `master_agent.execute(...)` 调用包装
  - [ ] 线程结束后的订阅清理
  - [ ] 最终状态归一

#### 6.2 收口 Route

- [ ] 缩减 `backend/routes/agent_api/stream_run.py` 的职责，只保留：
  - [ ] 参数解析
  - [ ] session_id 生成
  - [ ] 调用 `ExecutionService.submit(...)`
  - [ ] 基于 session event bus 建立 `SSEAdapter`
  - [ ] 返回 SSE Response
- [ ] 移除 Route 里的直接 `threading.Thread(...)`
- [ ] 移除 Route 里对 `TaskRegistry.register(...)` 的直接控制

#### 6.3 整理 helper

- [ ] 评估 `backend/routes/agent_api/stream_helpers.py` 哪些逻辑继续保留为 Agent 业务 helper
- [ ] 将纯执行生命周期逻辑迁出 route helper
- [ ] 保留 run_steps / final_answer / compression 等 Agent 专属副作用在 adapter 层

#### 6.4 统一最终状态

- [ ] 统一 “Agent 内部 `run_end(status=...)`” 与 “registry 最终状态” 的归一规则
- [ ] 明确：
  - [ ] 成功 -> `completed`
  - [ ] 用户中断 -> `interrupted`
  - [ ] 超时 -> `timed_out`
  - [ ] 未知异常 -> `failed`

### 涉及文件

- [ ] `backend/execution/adapters/agent_execution.py`
- [ ] `backend/routes/agent_api/stream_run.py`
- [ ] `backend/routes/agent_api/stream_helpers.py`
- [ ] `backend/services/execution_service.py`
- [ ] `backend/agents/task_registry.py`

### 建议测试

- [ ] 流式执行 happy path 测试
- [ ] 同 session 并发拒绝测试
- [ ] 中断测试
- [ ] SSE 断开但任务继续执行测试
- [ ] 最终状态归一测试

### 完成定义

- [x] Route 不再直接起线程
- [ ] Agent 流式任务通过统一执行入口发起
- [ ] SSE 行为与重连协议保持兼容

---

## 7. Phase 4：收口 Agent 控制接口与状态接口

### 目标

让 Agent 相关控制端点改为依赖 `ExecutionService`，而不是散落依赖 `TaskRegistry` 细节。

### 待办

- [ ] 将 `/stream/stop` 改为调用 `ExecutionService.cancel(...)`
- [ ] 将 session task-status 查询改为调用 `ExecutionService.get_status(...)`
- [ ] 如有必要，补充按 `task_id` 的查询接口
- [ ] 保持现有前端契约兼容：
  - [ ] `session_id`
  - [ ] `has_running_task`
  - [ ] `task_info`
- [ ] 确认 `stream_reconnect` 仍然只依赖 session event bus 与运行状态查询

### 涉及文件

- [ ] `backend/routes/agent_api/stream_control.py`
- [ ] `backend/routes/agent_api/execution_sync.py`
- [ ] `backend/services/execution_service.py`

### 建议测试

- [ ] stop 接口回归测试
- [ ] task-status 回归测试
- [ ] reconnect 回归测试

### 完成定义

- [ ] Agent 控制端点不再直接编排 registry 内部细节
- [ ] `ExecutionService` 成为统一控制入口

---

## 8. Phase 5：接管 Node 执行入口

### 目标

让 Node 执行接入统一执行入口，但第一阶段不侵入所有 Node 内部实现。

### 待办

#### 8.1 新增 Node adapter

- [ ] 创建 `backend/execution/adapters/node_execution.py`
- [ ] 实现 `NodeExecutionAdapter`
- [ ] 包装 `NodeService.execute_node(...)`
- [ ] 支持以下统一字段：
  - [ ] `task_id`
  - [ ] `execution_kind=node_execute`
  - [ ] `timeout_seconds`
  - [ ] `cancel_event`
  - [ ] `metadata`

#### 8.2 修改 Route

- [ ] 将 `backend/routes/nodes.py` 的 `/execute` 改为调用 `ExecutionService.run(...)`
- [ ] 保持 HTTP 响应结构不变
- [ ] 不让 Route 直接承载潜在的长耗时执行控制逻辑

#### 8.3 保持 Node 内核最小改动

- [ ] 第一阶段不改 `INode.execute()` 签名
- [ ] 第一阶段不要求所有 Node 支持中途取消
- [ ] 仅在包装层统一 timeout / 状态记录 / 错误归类

### 涉及文件

- [ ] `backend/execution/adapters/node_execution.py`
- [ ] `backend/routes/nodes.py`
- [ ] `backend/services/node_service.py`
- [ ] 如有必要，个别长耗时 Node 的配置读取处

### 建议测试

- [ ] `/api/nodes/execute` 回归测试
- [ ] Node 执行异常包装测试
- [ ] timeout 语义测试

### 完成定义

- [ ] Node 执行已通过统一执行入口发起
- [ ] Route 不再直接承担 Node 执行控制语义

---

## 9. Phase 6：接管 MCP 执行入口

### 目标

把 MCP 的连接、测试、工具调用统一纳入 execution layer，对外不再把 `MCPClientManager` 当成执行入口。

### 待办

#### 9.1 新增 MCP adapter

- [ ] 创建 `backend/execution/adapters/mcp_execution.py`
- [ ] 实现 `MCPExecutionAdapter`
- [ ] 支持包装以下动作：
  - [ ] `connect_server`
  - [ ] `disconnect_server`
  - [ ] `test_connection`
  - [ ] `call_tool`
  - [ ] 如有必要，`refresh_server`

#### 9.2 修改 MCP service

- [ ] 让 `MCPService` 通过 `ExecutionService` 发起 connect/test/call
- [ ] 重新定位 `MCPClientManager`：
  - [ ] 负责连接管理
  - [ ] 负责 SDK 桥接
  - [ ] 不再承担对外统一执行层职责

#### 9.3 接管 Agent 内部 MCP 工具调用

- [ ] 修改 `backend/tools/tool_executor_modules/dispatcher.py`
- [ ] 将 `mcp__*` 工具调用改为走统一执行入口
- [ ] 保证对 Agent 来说，MCP 调用也具备统一 task/status/timeout 语义

#### 9.4 首轮保持边界

- [ ] 不重写 `MCPClientManager` 内部 event loop
- [ ] 不承诺 MCP SDK 调用的硬取消
- [ ] 先把外层入口和状态语义统一

### 涉及文件

- [ ] `backend/execution/adapters/mcp_execution.py`
- [ ] `backend/services/mcp_service.py`
- [ ] `backend/mcp/client_manager.py`
- [ ] `backend/tools/tool_executor_modules/dispatcher.py`

### 建议测试

- [ ] MCP connect/disconnect/test 回归测试
- [ ] MCP tool call timeout 语义测试
- [ ] Agent 内部 MCP 工具调用回归测试

### 完成定义

- [ ] MCP 对外执行入口统一经过 `ExecutionService`
- [ ] `MCPClientManager` 不再是执行平面外露入口

---

## 10. Phase 7：测试、守卫与收尾

### 目标

在边界固化后，补齐回归测试、架构守卫和文档收口。

### 待办

#### 10.1 测试

- [ ] 为 execution layer 增加单元测试
- [ ] 为 Agent/Node/MCP 接入点增加回归测试
- [ ] 补取消、超时、状态归一测试
- [ ] 补 runtime container 装配测试

#### 10.2 架构守卫

- [ ] 评估是否为以下方向补 AST 守卫：
  - [ ] Route 不直接创建线程
  - [ ] Route 不直接操作 `TaskRegistry.register(...)`
  - [ ] Route 不直接依赖 `MCPClientManager` 执行入口
- [ ] 如已有守卫测试体系，补到对应 guard test 中

#### 10.3 文档

- [ ] 更新 `docs/P3_EXECUTION_LAYER_DESIGN.md` 中的实施状态
- [ ] 更新本清单勾选状态
- [ ] 如实现落地与设计有偏差，补差异说明

### 建议测试文件候选

- [ ] `backend/tests/runtime_execution_plane_test.py`
- [ ] 新增 `backend/tests/execution_service_test.py`
- [ ] 新增 Agent 流式执行回归测试
- [ ] 新增 Node 执行入口回归测试
- [ ] 新增 MCP 执行入口回归测试

### 完成定义

- [ ] 有最小但完整的回归保障
- [ ] 文档、实现、测试三者一致

---

## 11. 第一批建议 PR 切分

### PR-1：执行层骨架

- [ ] `execution/models.py`
- [ ] `execution/in_process_runner.py`
- [ ] `services/execution_service.py`
- [ ] `runtime/container.py` 装配
- [ ] 基础单测

### PR-2：`TaskRegistry` 扩展

- [ ] task-aware registry
- [ ] 状态模型扩展
- [ ] session 兼容接口保留
- [ ] registry 回归测试

### PR-3：Agent 流式接入

- [ ] `AgentExecutionAdapter`
- [ ] `stream_run.py` 收口
- [ ] 状态/取消归一
- [ ] SSE 回归测试

### PR-4：Agent 控制接口收口

- [ ] `/stream/stop`
- [ ] `task-status`
- [ ] reconnect 回归

### PR-5：Node 执行接入

- [ ] `NodeExecutionAdapter`
- [ ] `routes/nodes.py` 接入
- [ ] Node 回归测试

### PR-6：MCP 执行接入

- [ ] `MCPExecutionAdapter`
- [ ] `MCPService` 接入
- [ ] dispatcher 中 `mcp__*` 接入
- [ ] MCP 回归测试

### PR-7：守卫与文档收尾

- [ ] 架构守卫
- [ ] 文档状态更新
- [ ] 完整回归

---

## 12. 明确暂不实施项

以下事项在本清单执行过程中默认不做，除非单独立项：

- [ ] 不迁移到 ASGI
- [ ] 不引入 Celery / Redis / RQ / 独立 worker
- [ ] 不重写 `MCPClientManager` 的 loop 模型
- [ ] 不批量修改全部 Node 的 `execute()` 签名
- [ ] 不重构 Agent 的消息持久化模型
- [ ] 不合并 `EventBus` 与 `TaskRegistry` 两套审批/输入等待机制

---

## 13. 完成标准（P3 第一阶段）

当以下条件全部满足时，可认为 P3 第一阶段完成：

- [x] Route 不再直接起线程
- [x] Agent 流式执行统一经过 `ExecutionService`
- [x] Node 执行统一经过 `ExecutionService`
- [x] MCP 外部执行入口统一经过 `ExecutionService`
- [x] 统一状态语义已落地：`starting` / `running` / `cancel_requested` / `completed` / `failed` / `interrupted` / `timed_out`
- [x] `RuntimeContainer` 成为执行层唯一装配入口
- [x] 现有 SSE / 重连协议保持兼容
- [x] 有覆盖取消、超时、状态归一的最小回归测试

## 14. 推荐启动顺序

如果现在要正式开工，建议从下面的顺序开始：

1. Phase 1：执行层骨架  
2. Phase 2：`TaskRegistry` 扩展  
3. Phase 3：Agent 流式接管

原因：

- 这三步能最早解决 P3 中最核心的问题：Route 直接起线程。
- Node 和 MCP 可以在执行层骨架稳定后再平滑接入。
- 这样最符合“先收口执行控制，再逐步接业务入口”的策略。
