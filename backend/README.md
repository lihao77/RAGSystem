# 后端

`backend/` 是当前系统的 Flask 后端，核心是：

- Agent Runtime
- Execution
- MCP
- Model Adapter
- Tools
- Files / Vector

## 启动

```powershell
cd backend
python app.py
```

默认地址：`http://localhost:5000`

## 当前目录

- `app.py`：后端入口
- `routes/`：当前 HTTP API
- `agents/`：Agent 加载、编排、上下文、流式执行
- `execution/`：统一执行与观测
- `application/`：Agent 用例编排
- `capabilities/`：Agent 能力适配层
- `mcp/`：MCP Server 接入
- `model_adapter/`：模型 Provider 适配层
- `tools/`：默认工具、权限、代码沙箱
- `file_index/`、`vector_store/`：文件与向量能力
- `tests/`：后端测试

## 当前 API 前缀

- `/api/agent`
- `/api/agent-config`
- `/api/model-adapter`
- `/api/mcp`
- `/api/files`
- `/api/vector-library`
- `/api/embedding-models`

## 当前不再包含

- GraphRAG / Search / Visualization
- Nodes / Workflows
- Neo4j 直连
- 旧管理端 `frontend/`（已下线，不再参与运行）

## 相关文档

- [agents/README.md](agents/README.md)
- [config/README.md](config/README.md)
- [model_adapter/README.md](model_adapter/README.md)
- [tools/README.md](tools/README.md)
- [scripts/README.md](scripts/README.md)
