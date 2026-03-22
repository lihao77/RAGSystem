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

使用示例文件创建本地配置：

```bash
cp backend-fastapi/.env.example backend-fastapi/.env
cp backend-fastapi/model_adapter/configs/providers.yaml.example backend-fastapi/model_adapter/configs/providers.yaml
cp backend-fastapi/agents/configs/agent_configs.yaml.example backend-fastapi/agents/configs/agent_configs.yaml
cp backend-fastapi/mcp/configs/mcp_servers.yaml.example backend-fastapi/mcp/configs/mcp_servers.yaml
cp backend-fastapi/config/yaml/config.yaml.example backend-fastapi/config/yaml/config.yaml
cp frontend-client/.env.example frontend-client/.env
```

## 常用接口与页面 / Common endpoints and pages

- `POST /api/agent/stream` — 流式执行 / streaming execution
- `POST /api/agent/execute` — 同步执行 / synchronous execution
- `GET /api/agent/execution/overview` — 执行概览 / execution overview
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
