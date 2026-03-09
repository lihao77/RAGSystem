# 后端

`backend/` 是 Flask 服务端，负责配置加载、节点系统、工作流、Model Adapter、Agent、MCP、图谱和向量相关 API。

## 启动

```powershell
cd backend
pip install -r requirements.txt
python app.py
```

默认地址：`http://localhost:5000`

## 启动前配置

建议至少准备：

```powershell
Copy-Item .env.example .env
Copy-Item model_adapter\configs\providers.yaml.example model_adapter\configs\providers.yaml
```

按需准备：

```powershell
Copy-Item config\yaml\config.yaml.example config\yaml\config.yaml
Copy-Item agents\configs\agent_configs.yaml.example agents\configs\agent_configs.yaml
Copy-Item mcp\configs\mcp_servers.yaml.example mcp\configs\mcp_servers.yaml
```

## 当前入口

- `app.py`：应用工厂、blueprint 注册、静态路由、启动检查
- `config/`：系统配置模型与健康检查
- `routes/`：HTTP API
- `model_adapter/`：Provider 适配与配置存储
- `agents/`：Agent 加载、执行、事件和监控
- `nodes/`：节点定义、配置 Schema 与配置存储
- `tools/`：工具定义、执行器与权限控制
- `scripts/`：维护脚本
- `tests/`：后端测试

## 已注册的主要 API 前缀

- `/api/home`
- `/api/search`
- `/api/visualization`
- `/api/evaluation`
- `/api/graphrag`
- `/api/function-call`
- `/api/config`
- `/api/nodes`
- `/api/workflows`
- `/api/files`
- `/api/vector`
- `/api/vector-library`
- `/api/model-adapter`
- `/api/agent`
- `/api/agent-config`
- `/api/embedding-models`
- `/api/mcp`

## 运行时行为

- 启动前执行 `config.health_check.run_health_check()`
- 通过 `.env` 读取 `FLASK_HOST`、`FLASK_PORT`、`FLASK_DEBUG`、`CORS_ORIGINS`
- 默认上传目录为 `backend/uploads`
- 默认静态目录为 `../frontend/dist`
- 启动时按配置尝试初始化 Neo4j、向量库和 MCP Client Manager

## 常用检查

```powershell
python -m pytest tests\config_schema_test.py
python -m pytest tests\execution_service_test.py
python -m pytest tests\route_observability_contract_test.py
python -m pytest tests\model_adapter_config_store_test.py
python scripts\runtime_strict_audit.py --format table
```

## 子系统文档

- [config/README.md](config/README.md)
- [model_adapter/README.md](model_adapter/README.md)
- [tools/README.md](tools/README.md)
- [scripts/README.md](scripts/README.md)
- [agents/README.md](agents/README.md)
- [nodes/CONFIG_UI_GUIDE.md](nodes/CONFIG_UI_GUIDE.md)
