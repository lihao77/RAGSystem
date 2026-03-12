# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

这是一个基于 FastAPI 的多智能体（Multi-Agent）协作后端系统，采用 ReAct 模式的 OrchestratorAgent 动态编排多个子 Agent，支持 MCP（Model Context Protocol）、SSE 流式执行、向量数据库检索和 Skills 系统。

## 启动和运行

```bash
# 安装依赖
pip install -r requirements.txt

# 开发模式（使用 .env 中的配置）
python main.py

# 或直接用 uvicorn
uvicorn main:app --host 0.0.0.0 --port 5001 --reload
```

环境变量从项目根目录的 `.env` 文件加载，参考 `.env.example`：
- `FASTAPI_HOST`、`FASTAPI_PORT`、`FASTAPI_RELOAD`
- `CORS_ORIGINS`：前端地址
- `UPLOAD_FOLDER`：文件上传目录
- `FRONTEND_DIST`：前端构建产物目录（可选）

## 测试

测试目录在 `agents/tests/test_core/`，使用 pytest：

```bash
# 运行全部测试
pytest agents/tests/

# 运行单个测试文件
pytest agents/tests/test_core/test_base.py

# API 集成测试可用 FastAPI TestClient
```

## 高层架构

### 请求数据流

```
HTTP 请求 → FastAPI 路由 (api/v1/)
  → FastAPI Depends() 注入 (runtime/dependencies.py)
  → RuntimeContainer 单例 (runtime/container.py)
  → AgentOrchestrator (agents/core/orchestrator.py)
  → OrchestratorAgent 编排 (agents/implementations/orchestrator/agent.py)
  → 子 Agent / Tools / Skills / MCP 工具
  → SSE 流式或同步 JSON 响应
```

### 核心层次

**`runtime/container.py`** — `RuntimeContainer` 是整个应用的中央单例服务容器，持有 `AgentOrchestrator`、`ModelAdapter`、`MCPManager`、`VectorStore` 等所有核心服务的实例。所有服务通过它获取，而不是直接实例化。

**`lifespan.py`** — 应用启动顺序严格按序：RuntimeContainer → 健康检查 → 向量库 → Agent 运行时 → MCP。修改初始化顺序时需注意依赖关系。

**`agents/core/`** — Agent 子系统核心：
- `base.py`：`BaseAgent` 抽象基类，所有 Agent 必须实现 `execute()` 和 `can_handle()`
- `orchestrator.py`：`AgentOrchestrator`，路由任务到具体 Agent
- `context.py`：`AgentContext`，支持 `fork()`/`merge()` 的分层上下文和共享黑板（`shared_data`/`blackboard`）
- `registry.py`：Agent 注册表

**`agents/implementations/orchestrator/agent.py`** — `OrchestratorAgent` 是主编排器，采用 ReAct 模式，将其他子 Agent 作为工具调用，输出 XML 格式的流式响应。

**`model_adapter/adapter.py`** — `ModelAdapter` 统一多 LLM Provider 接口（OpenAI、DeepSeek、ModelScope、OpenRouter 等），Provider 实例配置在 `model_adapter/configs/providers.yaml`。

### 配置系统

三层 YAML 配置，各自职责不同：

| 配置文件 | 职责 |
|---------|------|
| `agents/configs/agent_configs.yaml` | Agent 定义（名称、LLM、工具、Skills、MCP 服务器）|
| `model_adapter/configs/providers.yaml` | LLM Provider 实例（API key、base_url、模型列表）|
| `mcp/configs/mcp_servers.yaml` | MCP 服务器连接配置 |
| `config/yaml/config.yaml` | 系统级配置（向量库、embedding）|

Agent 配置支持热加载，可通过 `/api/agent-config/` API 动态修改。

### Skills 系统

Skills 位于 `agents/skills/`，采用渐进式加载策略：
1. `SKILL.md` — 描述 Skill 功能（Agent 激活前读取）
2. `activate` — 激活后加载详细指令
3. `load_resource` — 按需加载资源
4. `execute` — 实际执行

在 `agent_configs.yaml` 中通过 `skills.enabled_skills` 启用，`auto_inject: true` 时自动注入到 Agent 上下文。

### API 路由结构

所有 API 挂载在 `api/v1/` 下，前缀：
- `/api/agent` — 执行、流式、会话、Agent 管理
- `/api/agent-config` — Agent 配置 CRUD
- `/api/model-adapter` — LLM Provider 管理
- `/api/mcp` — MCP 服务器管理
- `/api/files` — 文件上传
- `/api/vector-library` — 向量库查询
- `/api/embedding-models` — Embedding 模型管理

SSE 流式执行入口：`POST /api/agent/stream`

### 事件系统

`agents/events/` 包含事件总线（`bus.py`）、发布者（`publisher.py`）、会话管理（`session_manager.py`）和 SSE 适配器（`sse_adapter.py`）。SSE 流在 `api/v1/stream.py` 中处理，支持停止（`/stream/stop`）和重连（`/stream/reconnect`）。

## 新增 Agent 的步骤

1. 在 `agents/implementations/` 下创建新目录和 Agent 类，继承 `BaseAgent`
2. 实现 `execute(task, context) -> AgentResponse` 和 `can_handle()` 方法
3. 在 `agents/core/registry.py` 注册
4. 在 `agents/configs/agent_configs.yaml` 添加配置项

## 新增 LLM Provider 的步骤

1. 在 `integrations/model_providers/` 创建 Provider 类
2. 在 `model_adapter/configs/providers.yaml` 添加 Provider 实例配置
3. 通过 `/api/model-adapter/providers` API 或直接编辑 YAML 管理
