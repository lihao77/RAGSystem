# RAGSystem

RAGSystem 当前是一个 `Agent-first` 系统：

- `backend-fastapi/`：FastAPI 后端，提供 Agent、Execution、MCP、Model Adapter、Files、Vector 等能力
- `frontend-client/`：聊天、执行监控、Agent 配置、MCP 管理前端

旧图谱、节点、工作流、Neo4j 直连链路已经移除，不再属于当前系统。

## 快速启动

后端：

```powershell
cd backend-fastapi
python main.py
```

前端：

```powershell
cd frontend-client
npm install
npm run dev
```

## 最小配置

建议至少准备：

```powershell
cd backend-fastapi
Copy-Item .env.example .env
Copy-Item model_adapter\configs\providers.yaml.example model_adapter\configs\providers.yaml
Copy-Item agents\configs\agent_configs.yaml.example agents\configs\agent_configs.yaml
Copy-Item mcp\configs\mcp_servers.yaml.example mcp\configs\mcp_servers.yaml
```

可选：

```powershell
Copy-Item config\yaml\config.yaml.example config\yaml\config.yaml
```

## 当前文档

- [docs/README.md](docs/README.md)
- [backend-fastapi/agents/README.md](backend-fastapi/agents/README.md)
- [backend-fastapi/model_adapter/README.md](backend-fastapi/model_adapter/README.md)
- [frontend-client/README.md](frontend-client/README.md)
