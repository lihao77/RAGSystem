# RAGSystem

RAGSystem 是一个由 Flask 后端、两个 Vue 前端和一组可配置 Agent/Node 子系统组成的工程仓库。

当前实现包含三部分：

- `backend/`：API、配置加载、节点系统、工作流、Model Adapter、Agent、MCP、向量与图谱能力
- `frontend/`：后台管理端，负责配置、节点、工作流、文件、图谱、向量、模型、MCP、Agent 页面
- `frontend-client/`：对话与执行监控端，负责聊天、监控、Agent 配置和 MCP 管理

## 启动

### 1. 安装依赖

```powershell
cd backend
pip install -r requirements.txt

cd ..\frontend
npm install

cd ..\frontend-client
npm install
```

### 2. 准备后端配置

最少建议准备：

```powershell
cd backend
Copy-Item .env.example .env
Copy-Item model_adapter\configs\providers.yaml.example model_adapter\configs\providers.yaml
```

按需准备：

```powershell
Copy-Item config\yaml\config.yaml.example config\yaml\config.yaml
Copy-Item agents\configs\agent_configs.yaml.example agents\configs\agent_configs.yaml
Copy-Item mcp\configs\mcp_servers.yaml.example mcp\configs\mcp_servers.yaml
```

说明：

- `.env` 控制 `FLASK_PORT`、`FLASK_HOST`、`CORS_ORIGINS`、上传目录和静态目录
- `model_adapter/configs/providers.yaml` 保存 LLM / Embedding provider
- `config/yaml/config.yaml` 覆盖 `backend/config/models.py` 默认值
- `agents/configs/agent_configs.yaml` 保存用户 Agent 配置
- `mcp/configs/mcp_servers.yaml` 保存 MCP Server 配置

### 3. 启动服务

```powershell
cd backend
python app.py
```

后端默认地址：`http://localhost:5000`

```powershell
cd frontend
npm run dev
```

后台管理端默认地址：`http://localhost:8080`

```powershell
cd frontend-client
npm run dev
```

对话与监控端默认地址：`http://localhost:5174`

## 当前入口

- 管理端路由定义：`frontend/src/router/index.js`
- 对话端页面切换：`frontend-client/src/App.vue`
- 后端入口：`backend/app.py`
- Agent 加载：`backend/agents/config/loader.py`
- 节点定义与 Schema：`backend/nodes/`
- Model Adapter：`backend/model_adapter/`
- 维护脚本：`backend/scripts/`
- 后端测试：`backend/tests/`

## 常用检查

说明：以下测试命令依赖 `pytest`。当前 `backend/requirements.txt` 不包含它，如未安装请先执行：

```powershell
pip install pytest
```

```powershell
python -m pytest backend\tests\config_schema_test.py
python -m pytest backend\tests\execution_service_test.py
python -m pytest backend\tests\route_observability_contract_test.py
python backend\scripts\runtime_strict_audit.py --format table
```

## 文档

- [快速参考](QUICK_REFERENCE.md)
- [项目结构](PROJECT_STRUCTURE.md)
- [前端使用](FRONTEND_USAGE_GUIDE.md)
- [文档中心](docs/README.md)
- [后端说明](backend/README.md)
- [管理端说明](frontend/README.md)
- [对话端说明](frontend-client/README.md)
