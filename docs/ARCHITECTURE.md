# 架构总览

当前仓库已经收缩为一个 `Agent-first` 系统。

主链路：

`HTTP API -> Agent Runtime -> Execution -> Tools -> MCP / Skills / Vector / Files`

当前分层：

`routes -> application -> execution -> capabilities -> services / MCP / external systems`

## 后端组成

- `backend-fastapi/agents/`
  - Agent 配置、加载、编排、上下文、流式执行、事件与监控
- `backend-fastapi/execution/`
  - 统一执行入口、状态查询、取消、超时、观测字段
- `backend-fastapi/application/`
  - Agent 会话、恢复、重试等用例编排
- `backend-fastapi/capabilities/`
  - 文档、向量、MCP 等能力适配层
- `backend-fastapi/model_adapter/`
  - 多模型 / 多 Provider 统一适配层
- `backend-fastapi/mcp/`
  - MCP Server 配置、连接管理、工具注入
- `backend-fastapi/tools/`
  - 默认工具定义、执行器、权限与代码沙箱
- `backend-fastapi/file_index/` + `backend-fastapi/vector_store/`
  - 文件索引、向量库与检索相关能力
- `backend-fastapi/services/conversation_store.py`
  - 会话与消息持久化

## 默认 API 面

当前后端默认注册：

- `/api/agent`
- `/api/agent-config`
- `/api/model-adapter`
- `/api/mcp`
- `/api/files`
- `/api/vector-library`
- `/api/embedding-models`

## 默认工具面

静态工具定义位于 `backend-fastapi/tools/catalog/`，当前只保留通用能力：

- 文档读取与抽取
- 文件读写
- 数据转换
- 图表与地图生成
- 受限代码执行

动态工具：

- MCP 工具：运行时注入
- Skills 系统工具：启用 Skill 时自动注入

## 已删除的旧系统

以下能力已不再属于当前系统：

- Neo4j 直连
- 图谱搜索 / GraphRAG / 图谱可视化
- 节点系统
- 工作流系统
- 旧 Function Calling API
- `json2graph` / `llmjson` 集成链
- 已下线的旧管理端 `frontend/`（不再参与运行，目录可手动清理）
