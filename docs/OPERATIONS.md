# 运维说明

## 启动

后端：

```powershell
cd backend
python app.py
```

前端：

```powershell
cd frontend-client
npm install
npm run dev
```

## 最小配置

建议至少准备以下文件：

```powershell
cd backend
Copy-Item .env.example .env
Copy-Item model_adapter\configs\providers.yaml.example model_adapter\configs\providers.yaml
Copy-Item agents\configs\agent_configs.yaml.example agents\configs\agent_configs.yaml
Copy-Item mcp\configs\mcp_servers.yaml.example mcp\configs\mcp_servers.yaml
```

可选：

```powershell
Copy-Item config\yaml\config.yaml.example config\yaml\config.yaml
```

## 常用入口

- Agent 列表：`GET /api/agent/agents`
- Agent 流式执行：`POST /api/agent/stream`
- Agent 同步执行：`POST /api/agent/execute`
- Agent 配置：`/api/agent-config`
- 模型配置：`/api/model-adapter`
- MCP 管理：`/api/mcp`

## 常用验证

```powershell
python -m unittest backend.tests.agent_first_refactor_guards_test backend.tests.storage_refactor_guards_test backend.tests.runtime_strict_audit_test backend.tests.route_observability_contract_test
python backend\scripts\runtime_strict_audit.py --format table
```

## 当前不再支持

不要再尝试启动或接回以下系统：

- GraphRAG / Search / Visualization
- Nodes / Workflows
- Neo4j 直连后端
- 旧管理端 `frontend/`（已下线，不再参与运行）
