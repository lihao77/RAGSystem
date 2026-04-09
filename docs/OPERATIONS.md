# 运行说明 / Operations Guide

## 服务入口 / Service entrypoints

### 后端 / Backend

```bash
cd backend-fastapi
python main.py
```

- 默认地址 / Default URL: `http://localhost:5001`
- 可通过 `.env` 配置 `FASTAPI_HOST`、`FASTAPI_PORT`、`FASTAPI_RELOAD`
- 若 `frontend-client/dist` 存在，后端会托管前端构建产物

### 前端 / Frontend

```bash
cd frontend-client
npm install
npm run dev
```

- 默认地址 / Default URL: `http://localhost:5174`
- `/api` 代理到 / proxies to `http://localhost:5001`
- 可通过 `frontend-client/.env` 配置 `VITE_DEV_PORT` 与 `VITE_API_PROXY_TARGET`

## 最小配置链路 / Minimal configuration chain

先复制环境变量示例：

```bash
cp backend-fastapi/.env.example backend-fastapi/.env
cp frontend-client/.env.example frontend-client/.env
```

后端启动时只会自动初始化 app 与 agent 的运行时配置；MCP 与模型提供方配置需由用户在运行时目录中自行创建，正式生效配置优先从运行时目录读取，而不是直接从 `backend-fastapi/...` 源码目录读取。

- 默认运行时配置根目录：`~/.ragsystem/config`
- 若设置 `RAG_DATA_ROOT`，则配置目录变为 `<RAG_DATA_ROOT>/config`
- 运行时主配置文件：
  - `app/config.yaml`
  - `agents/team_index.yaml`
  - `agents/teams/*.yaml`
  - `mcp/mcp_servers.yaml`（按需创建）
  - `model_adapter/providers.yaml`（按需创建）

源码目录中的以下文件现在只作为 app / agent 初始化来源：

- `backend-fastapi/config/yaml/config.yaml.example`
- `backend-fastapi/agents/configs/agent_configs.yaml.example`

MCP 与模型提供方配置不再在启动时自动 seed；如果缺失，可在运行时目录手动创建，或通过前端管理页面写入。

## 常用接口与页面 / Common endpoints and pages

- `POST /api/agent/stream` — 流式执行 / streaming execution
- `POST /api/agent/execute` — 同步执行 / synchronous execution
- `GET /api/agent/execution/overview` — 执行概览 / execution overview
- `/monitor` — 监控页面 / monitoring UI
- `/team-builder` — Team 编排页面 / team composition UI
- `/agent-config` — Agent 配置页面 / agent configuration UI
- `/mcp` — MCP 管理页面 / MCP management UI
- `/vector-library` — 向量库页面 / vector library UI
- `/model-providers` — 模型提供方页面 / model provider UI

## 验证命令 / Verification commands

```bash
cd backend-fastapi
python -m compileall .
python -m py_compile main.py
pytest --basetemp=.pytest-tmp agents/tests/
cd ../frontend-client && npm run build
```
