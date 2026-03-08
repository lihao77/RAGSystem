# RAGSystem 架构边界与演进路线图

本文档用于把当前仓库中已经形成的运行时边界、分层方向和后续演进顺序固化为可执行约束。

## 1. 当前判断

当前系统已经从“模块直接互相引用”的形态，演进到“有 runtime + service + integration 边界”的中间阶段，但还没有完全制度化。

### 已经成立的锚点

- `backend/runtime/container.py`
  - 已作为运行时对象装配中心存在，并在 `backend/app.py` 中接入 Flask 生命周期。
- `backend/routes/nodes.py`
  - 已通过 `NodeService` 暴露节点能力，而不是在 route 中直接编排节点细节。
- `backend/routes/agent_config.py`
  - 已通过 `AgentConfigService` 处理配置相关业务逻辑。
- `backend/integrations/errors.py`
  - 已建立统一的 integration 异常基类。
- `backend/integrations/model_providers/factory.py`
  - 已将 provider 类型到具体实现的映射收口到 integrations 层。
- `backend/tests/test_refactor_guards.py`
  - 已存在一批 AST 守卫测试，说明边界不是纯口头约定。

### 仍然存在的现实问题

- 目前还不能将整体状态定义为完整的 `routes -> services -> ports/abstractions -> integrations`。
- 仓库里还没有稳定、统一的 `ports/` 或 `abstractions/` 层；多数链路仍是 `routes -> services -> concrete modules`。
- 仍有一些 route 直接访问 store、manager 或基础模块，而非统一 service。
- `runtime container` 还不是唯一入口，多个 getter 仍保留兼容性的全局 fallback 单例。
- 配置持久化已经分散在多个 YAML store 中，但还没有统一的原子写入、迁移、锁和版本治理能力。
- 部分重任务仍在 Web 进程请求路径内直接起线程或同步执行。

## 2. 目标边界

目标不是一次性“大重构”，而是在现有基础上把边界变成制度、测试和运维事实。

### 目标依赖方向

推荐的依赖方向为：

`routes -> services -> domain/ports -> integrations/infrastructure`

其中：

- `routes`
  - 负责协议适配、参数提取、状态码和统一响应格式。
- `services`
  - 负责业务用例编排，不直接承载 Flask、SSE、请求对象等 Web 细节。
- `domain/ports`
  - 负责稳定接口、领域规则和运行时可替换抽象。
- `integrations/infrastructure`
  - 负责第三方 SDK、文件系统、数据库、网络访问、外部协议适配。

### 需要长期坚持的规则

- Route 不直接 import 第三方集成层。
- Route 尽量不直接 import store/manager/conversation/db client。
- 运行时对象通过 `RuntimeContainer` 装配，不新增隐式全局单例。
- 集成层错误向统一异常模型靠拢。
- 非流式 HTTP API 尽量统一响应 envelope。

## 3. 优先级路线图

## P0：固化边界护栏

先把“约定”变成“文档 + 测试 + 审查规则”。

### 目标

- 明确哪些目录属于 route、service、integration、runtime。
- 明确允许和禁止的 import 方向。
- 扩展架构守卫测试，避免回退到模块互相直连。

### 建议动作

- 以本文档作为边界说明的单一入口。
- 扩展 `backend/tests/test_refactor_guards.py`，重点覆盖：
  - `backend/routes/mcp.py`
  - `backend/routes/workflows.py`
  - `backend/routes/vector_library.py`
  - `backend/routes/agent_api/shared.py`
- 新增守卫规则：
  - route 不直接 import `integrations.*`
  - route 不直接操作 YAML store
  - route 不直接创建运行时核心单例

### 同步处理的遗留项

- `service_manager` 兼容层已移除，统一以 `backend/runtime/container.py` 作为唯一装配中心。

### 验收标准

- 至少核心 route 模块已能通过 AST 守卫测试验证依赖方向。
- 新增功能必须沿用 service 入口，而不是直接向 route 注入底层模块。

## P1：让 RuntimeContainer 成为唯一运行时入口

当前容器已是主装配中心，但仍被 fallback 单例削弱。

### 优先处理文件

- `backend/config/__init__.py`
- `backend/model_adapter/adapter.py`
- `backend/services/node_service.py`
- `backend/services/agent_config_service.py`
- `backend/services/agent_runtime_service.py`
- `backend/mcp/client_manager.py`
- `backend/db.py`

### 建议动作

- 为这些 getter 去掉兼容性 fallback，或将 fallback 收敛为仅测试环境可用。
- 在应用启动阶段完成运行时实例注册，避免运行中隐式创建全局对象。
- 为 service、adapter、db、mcp 提供显式注入点，便于测试替换。

### 验收标准

- `backend/app.py` 之外不再依赖隐式全局单例完成核心对象初始化。
- 测试可通过 container 注入假对象，而不是 monkeypatch 全局模块变量。

### 当前落地策略（已执行）

当前已将 legacy fallback 逻辑统一收口到 `backend/runtime/dependencies.py`，而不是散落在各模块的 getter 中。

- 统一入口：
  - `get_runtime_dependency(...)`
- 当前行为：
  - 优先从 `RuntimeContainer` 获取依赖
  - 若容器未初始化，则退回 legacy fallback
  - 每个依赖名只告警一次，提示正在使用兼容路径
  - fallback 诊断会记录访问入口 / 上游调用，便于在测试中定位遗留调用链
  - 执行平面的 `task_registry` / `session_manager` 也已纳入同一套 runtime 解析策略
  - `node_registry` / `node_config_store` 也开始通过 runtime 统一解析，避免执行链再回落到包级单例/直接构造
  - `mcp_config_store` / `mcp_manager` 也已切到 runtime 主解析，`client_manager` 内部不再直接抓包级单例
  - `event_bus` 全局入口也已纳入 runtime 解析，默认发布链可在 strict mode 下被显式发现
- 严格模式：
  - 设置环境变量 `RAGSYSTEM_RUNTIME_STRICT=1`
  - 在容器未初始化时，getter 将直接报错，而不是静默 fallback
  - 报错信息会带上调用方位置，方便快速收敛 strict-mode 失败点

### Fallback Diagnostics

- 可通过 `runtime.get_runtime_fallback_stats()` 或 `runtime.dependencies.get_runtime_fallback_stats()` 查看 fallback 统计。
- 统计项包含：
  - `dependency_name`
  - `accessor`
  - `caller`
  - `count`
- 测试前可调用 `runtime.reset_runtime_fallback_tracking()` 清空告警和统计，避免不同用例互相污染。

### Legacy Fallback Policy

- 允许 fallback 的目的仅限于：
  - 兼容现有调用链
  - 便于逐步迁移测试
  - 降低一次性切换风险
- 不允许继续扩散 fallback 的范围：
  - 新增模块不得复制旧式全局单例 getter 模式
  - 新增运行时依赖必须优先挂入 `RuntimeContainer`
  - 若确需兼容 fallback，必须复用 `runtime.dependencies`，不能重新实现一套逻辑
- 对 legacy 装配层的态度：
  - `service_manager` 已移除
  - 不再保留第二套服务装配中心

### 下一步收口目标

- 在 CI / 测试环境中逐步启用 `RAGSYSTEM_RUNTIME_STRICT`
- 先从核心模块开始消除 fallback 创建行为，仅保留容器解析
- 最终目标是让 getter 成为“容器访问器”，而不是“容器优先 + 单例兜底”
- 可先用 `python backend/scripts/runtime_strict_audit.py --format table` 生成当前 fallback getter 清单

## P2：统一配置与存储基座

不要先抽象“大而全 BaseConfigStore”，优先抽“小而硬”的共享文件存储能力。

### 建议的基座拆分

- 已落第一刀：`backend/utils/yaml_store.py`
  - 提供统一 YAML 读取 + 原子写入（临时文件 + replace）
- 已落第二刀：`backend/utils/versioned_yaml_store.py`
  - 提供迁移落盘 + `.backup` 备份语义
- 已落第三刀：`backend/utils/file_lock.py`
  - 提供最小本地文件锁，统一保护 YAML 写入和迁移回写
- `AtomicFileStore`
  - 后续可继续扩为更通用的文件语义层
- `VersionedYamlStore`
  - schema version、迁移钩子、备份
- `FileLock`
  - 防止并发写坏配置

### 优先收口的模块

- `backend/model_adapter/config_store.py`（已接入）
- `backend/nodes/config_store.py`（已接入）
- `backend/workflows/store.py`（已接入）
- `backend/mcp/config_store.py`（已接入）
- `backend/agents/config/manager.py`（文件存储已接入；YAML/JSON 文本导入导出已与文件语义拆分）
- `backend/vector_store/vectorizer_config.py`（已接入）
- `backend/file_index/store.py`（已接入）
- `backend/services/config_service.py`（文件写入已接入；原始 YAML 文本读取与文本解析已拆分）
- `backend/config/base.py`（共享 YAML 读取已接入）
- `backend/config/schemas.py`（共享 YAML 读取已接入）
- `backend/utils/migrate_file_index.py`（迁移读取路径已接入）

### 当前进展（已执行）

- `backend/config/base.py`
  - 已改为复用 `utils.yaml_store.load_yaml_file(...)`，不再直接打开 YAML 文件。
- `backend/config/schemas.py`
  - `ProvidersConfig.load(...)` / `VectorizersConfig.load(...)` 已统一走共享 YAML 读取 helper。
- `backend/services/config_service.py`
  - 文件写入继续通过 `utils.versioned_yaml_store.save_versioned_yaml_file(...)`。
  - 原始配置读取已拆为“文件文本读取”与“YAML 字符串解析”两个 helper，避免把文件语义与文本语义混在一起。
- `backend/agents/config/manager.py`
  - 文件装载/持久化继续通过 `versioned_yaml_store`。
  - `export_config(...)` / `import_config(...)` 已拆为独立的 YAML/JSON 文本渲染与解析 helper。
- `backend/utils/migrate_file_index.py`
  - YAML 迁移脚本已复用共享读取 helper，避免再维护独立文件读取逻辑。
- `backend/tests/storage_refactor_guards_test.py`
  - 已新增一组 P2 静态守卫，确保上述模块继续沿用共享存储基座，而不是回退到散落的 YAML 文件操作。

### 统一能力

- 原子写入
- schema version
- 数据迁移
- 自动备份
- 文件锁
- 统一日志

### 验收标准

- 所有 YAML store 共享同一套写入语义。
- 迁移逻辑从业务 store 中下沉为公共能力。
- 任一配置模块损坏时能给出可定位、可恢复的错误信息。

## P3：建立执行平面

当前部分重任务仍在 Web 进程请求路径中执行。下一阶段应先抽统一执行层，再决定是否上更重的基础设施。

详细设计草案见：`docs/P3_EXECUTION_LAYER_DESIGN.md`

### 当前风险点

- `backend/routes/agent_api/stream_run.py`
  - 请求路径中直接创建后台线程执行任务。
- `backend/routes/nodes.py`
  - 节点执行仍由 Web 请求直接触发。
- `backend/mcp/client_manager.py`
  - 在进程内自管 asyncio 事件循环线程。

### 建议动作

- 先引入进程内 `execution service` 或 `execution layer`。
- 统一封装：
  - 取消
  - 超时
  - 重试
  - 状态记录
  - 资源预算/配额
- 复用现有 `TaskRegistry`、事件总线和 SSE 机制，不再新起一套调度模型。

### 验收标准

- route 不再直接管理线程生命周期。
- 节点执行、MCP 调用、长任务执行都通过统一执行入口发起。
- 取消和超时语义在不同执行类型间保持一致。

## P4：统一契约与观测性

边界固化后，应马上补齐服务契约和全链路可观测性。

### 契约测试优先级

- provider factory：输入配置 -> 输出正确 provider
- integration error：外部失败 -> 统一异常类型
- route response：非流式 API -> 统一 envelope

### 观测性建议

- 统一透传：
  - `request_id`
  - `session_id`
  - `run_id`
  - `task_id`
- 当前已落地首步：
  - 以 `ExecutionService` 为规范化入口补齐字段来源与继承规则
  - 通过 execution context + `contextvars` 在线程内自动透传
  - Agent SSE / reconnect / MCP / Node 已补兼容性附加字段
- 从以下模块开始落地：
  - `backend/services/agent_runtime_service.py`
  - `backend/mcp/client_manager.py`
  - `backend/routes/agent_api/stream_helpers.py`
- 逐步把现有结构化日志能力推广到 runtime、services、integrations。

### 响应契约说明

- 流式接口可保留 SSE 特性。
- 非流式接口优先统一到 `backend/utils/response_helpers.py` 的 envelope 语义。
- 历史兼容接口可分阶段改造，不要求一次切齐。

## P5：收敛前端边界

双前端可以短期并存，但需要先明确职责，再谈合并。

### 建议职责划分

- `frontend`
  - 管理控制台
  - 配置、资源、节点、运维类页面
- `frontend-client`
  - Agent 对话体验
  - 运行监控
  - 会话与交互链路

### 当前注意点

- `frontend-client` 目前已经包含 `/agent-config`、`/mcp` 等页面。
- 建议优先定义这些页面是：
  - 临时保留
  - 跳转到控制台
  - 保留只读视图
  - 后续迁出

### 验收标准

- 双前端对同一后端资源的职责边界清晰。
- API 契约与跳转策略先统一，页面不必马上合并。

## 4. 暂不建议立即做的事

以下事项当前收益低于成本，不建议放在本轮前排：

- 立即迁移到 ASGI
- 立即引入新的官方 SDK 体系并全局替换
- 立即合并双前端
- 继续做大规模目录重命名

## 5. 推荐执行顺序

建议按以下顺序推进：

1. `P0 边界护栏`
2. `P1 单一运行时入口`
3. `P2 配置与存储基座`
4. `P3 执行平面`
5. `P4 契约与观测性`
6. `P5 前端边界`

一句话总结：

> 先把边界写清、测住、守住，再去抽象执行层和存储层；先减少隐式耦合，再追求更大的技术升级。
