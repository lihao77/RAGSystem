# 智能体优先重构蓝图

本文档定义仓库从“混合型图谱/配置/节点/工作流系统”收敛为“功能强大的智能体系统”的目标边界、保留范围、下线范围与分阶段改造顺序。

## 1. 目标架构

目标系统按三层组织：

- `Agent Core`
  - Agent Runtime
  - Context / Memory
  - Execution / Observability
  - Permissions / Sandbox
- `Capabilities`
  - MCP
  - Skills
  - Document / File / Vector Retrieval
  - Code Execution / Data Processing
- `Ops Surface`
  - Agent Config
  - Model Adapter
  - MCP Config
  - Execution Monitoring

目标依赖方向：

`routes -> application/agent -> execution -> capabilities -> MCP/Skill/external services`

开发约束：

- 不再新增应用内 Neo4j 直连能力
- 不再新增图谱产品型 route/service
- 不再新增节点编排/工作流编排双轨架构
- 新能力优先暴露为 Agent Tool、MCP Tool 或 Skill

## 2. 保留范围

以下目录是目标系统主干，应继续保留并作为重构中心：

- `backend/agents/`
- `backend/execution/`
- `backend/model_adapter/`
- `backend/mcp/`
- `backend/conversation_store.py`
- `backend/tools/code_sandbox.py`
- `backend/tools/permissions.py`
- `backend/routes/agent_api/`
- `backend/routes/agent_config.py`
- `backend/routes/mcp.py`
- `backend/routes/model_adapter.py`
- `backend/services/agent_runtime_service.py`
- `backend/services/agent_api_runtime_service.py`
- `backend/services/agent_config_service.py`
- `backend/services/execution_service.py`
- `backend/services/mcp_service.py`
- `backend/services/model_adapter_service.py`
- `frontend-client/`

## 3. 保留但降级为外挂能力

以下能力仍可存在，但不再作为独立产品主链路，而是服务 Agent：

- `backend/agents/skills/`
- `backend/tools/document_tools.py`
- `backend/file_index/`
- `backend/vector_store/`
- `backend/routes/files.py`
- `backend/routes/vector_library.py`
- `backend/routes/embedding_models.py`

处理原则：

- 文件、向量、文档能力必须以 Tool / Capability 方式服务 Agent
- 可以保留轻量管理 API，但不再围绕它们建设主业务 UI

## 4. 下线范围

以下模块属于旧图谱产品或并行编排系统，应分阶段删除：

- `backend/db.py`
- `backend/services/query_service.py`
- `backend/services/search_service.py`
- `backend/services/visualization_service.py`
- `backend/services/graphrag_service.py`
- `backend/services/graphrag_api_service.py`
- `backend/routes/search_refactored.py`
- `backend/routes/visualization_refactored.py`
- `backend/routes/graphrag_refactored.py`
- `backend/routes/function_call.py`
- `backend/routes/home.py`
- `backend/routes/evaluation.py`
- `backend/nodes/`
- `backend/workflows/`
- `backend/services/node_service.py`
- `backend/services/workflow_service.py`
- `backend/routes/nodes.py`
- `backend/routes/workflows.py`
- `backend/integrations/json2graph/`
- `backend/integrations/llmjson/`
- `frontend/`

## 5. 必须改写的关键点

### 5.1 app 注册面

`backend/app.py` 最终应只注册以下蓝图：

- `agent`
- `agent_config`
- `mcp`
- `model_adapter`
- 可选：`files`、`vector_library`、`embedding_models`

以下蓝图应在迁移期间逐步取消注册：

- `search`
- `graphrag`
- `visualization`
- `function_call`
- `home`
- `evaluation`
- `nodes`
- `workflows`

### 5.2 配置面

`backend/config/` 和 `backend/services/config_service.py` 应收缩为：

- `agent`
- `model`
- `mcp`
- `vector`
- `system`

`neo4j` 不再是应用主配置项。若仍需图库能力，只能存在于 MCP Server 配置中。

### 5.3 Tool 定义

`backend/tools/function_definitions.py` 应去图谱产品化：

- 删除应用内 Cypher 执行及图库直连工具
- 保留文档、代码、文件、向量、MCP、Skill、审批与用户输入工具
- 图能力若继续保留，必须改为 MCP Tool 封装

### 5.4 运行时边界

Agent Core 代码不得回流依赖以下模块：

- `db`
- `services.search_service`
- `services.query_service`
- `services.graphrag_service`
- `services.graphrag_api_service`
- `services.visualization_service`
- `services.node_service`
- `services.workflow_service`

## 6. 建议新增目录

为避免 Route 与具体能力实现继续耦合，建议新增：

- `backend/application/`
  - 面向 Agent 用例编排
- `backend/capabilities/`
  - 面向 Agent 的可插拔能力抽象

建议新增模块：

- `backend/application/agent_chat.py`
- `backend/application/agent_session.py`
- `backend/application/agent_collaboration.py`
- `backend/capabilities/base.py`
- `backend/capabilities/mcp_tools.py`
- `backend/capabilities/document_retrieval.py`
- `backend/capabilities/vector_retrieval.py`

## 7. 分阶段执行清单

当前状态：

- `Phase 1` 已完成
- `Phase 2` 已完成
- `Phase 3` 已完成主要部分
- `Phase 4` 已完成主要部分
- `Phase 5` 已完成主要部分
- `Phase 6` 已完成主要部分

### Phase 1: 冻结旧架构扩散

状态：已完成

- 编写重构蓝图文档
- 补静态守卫测试，禁止 Agent Core 新增旧图谱/Neo4j 依赖
- 新功能禁止使用 `db.py`、`nodes/`、`workflows/`

### Phase 2: 收缩 API 面

状态：已完成

- 收紧 `backend/app.py` 蓝图注册
- 前端只保留 `frontend-client/` 主线
- 将旧图谱与节点工作流页面降级或下线

### Phase 3: 改造 Tool 层

状态：已完成主要部分

- 清理旧图谱工具定义
- 强化文档、代码、MCP、Skill 工具
- 为保留的图能力提供 MCP 包装层

### Phase 4: 去除应用内 Neo4j

状态：已完成主要部分

- 删除 `backend/db.py`
- 删除 Query/Search/GraphRAG/Visualization 直连链路
- Neo4j 仅通过 MCP 或 Skill 提供能力

### Phase 5: 删除并行编排系统

状态：已完成主要部分

- 删除 `nodes/`、`workflows/`
- 删除 `json2graph` / `llmjson` 旧集成目录
- 将剩余长任务统一接入 `ExecutionService`
- 旧 `frontend/` 已下线，目录清理可独立执行

### Phase 6: 目录重整

状态：已完成主要部分

- 引入 `application/`、`capabilities/`
- Agent 会话 / 恢复 / 重试编排迁入 `application/`
- 向量与 MCP 运营能力迁入 `capabilities/`
- Route 层继续保持 HTTP 适配职责

## 8. 验收标准

重构完成后，系统应满足：

- Agent 主链路可独立运行，不依赖 Neo4j 初始化
- 新能力可通过 Tool / MCP / Skill 接入
- Route 层不再承担旧产品业务逻辑
- 不存在节点工作流与智能体系统并行竞争主入口
- 旧图谱产品链路已删除或完全隔离
