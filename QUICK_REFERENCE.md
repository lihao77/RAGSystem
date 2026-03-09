# RAGSystem 快速参考

## 默认端口

- 后端：`http://localhost:5000`
- 管理端：`http://localhost:8080`
- 对话端：`http://localhost:5174`

后端默认允许的开发源包含 `5173`、`5174`、`8080`、`8081`，但当前两个前端默认端口是 `8080` 和 `5174`。

## 启动命令

```powershell
cd backend
python app.py
```

```powershell
cd frontend
npm run dev
```

```powershell
cd frontend-client
npm run dev
```

## 首次配置

```powershell
cd backend
Copy-Item .env.example .env
Copy-Item model_adapter\configs\providers.yaml.example model_adapter\configs\providers.yaml
```

可选：

```powershell
Copy-Item config\yaml\config.yaml.example config\yaml\config.yaml
Copy-Item agents\configs\agent_configs.yaml.example agents\configs\agent_configs.yaml
Copy-Item mcp\configs\mcp_servers.yaml.example mcp\configs\mcp_servers.yaml
```

## 管理端页面

- `/`：首页
- `/split`：综合视图
- `/search`：实体查询
- `/settings`：系统配置
- `/nodes`：节点系统
- `/workflow`：工作流编排
- `/files`：文件管理
- `/graphrag`：GraphRAG
- `/vector-service`：向量相关页面入口
- `/model-adapter`：Provider 管理
- `/mcp`：MCP 管理
- `/agent-config`：Agent 配置

## 对话端页面

- `/` 或 `/chat`：聊天
- `/monitor` 或 `/agent-monitor`：执行监控
- `/agent-config`：Agent 配置
- `/mcp`：MCP 管理

## 常用后端接口

- `GET /api/nodes/types`
- `GET /api/nodes/types/<node_type>/config-schema`
- `GET /api/workflows`
- `GET /api/model-adapter/providers`
- `GET /api/agent/agents`
- `POST /api/agent/execute`
- `POST /api/agent/stream`
- `GET /api/agent/execution/overview`
- `GET /api/agent/metrics`
- `POST /api/agent/metrics/reset`

## 常用文件

- `backend/app.py`
- `backend/agents/config/loader.py`
- `backend/config/models.py`
- `backend/model_adapter/configs/providers.yaml`
- `backend/agents/configs/agent_configs.yaml`
- `frontend/src/router/index.js`
- `frontend-client/src/App.vue`

## 常用检查

```powershell
python -m pytest backend\tests\config_schema_test.py
python -m pytest backend\tests\model_adapter_config_store_test.py
python -m pytest backend\tests\route_observability_contract_test.py
python backend\scripts\runtime_strict_audit.py --check-container-only
```
