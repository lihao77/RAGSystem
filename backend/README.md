# 后端服务

RAGSystem 后端基于 Flask，负责知识图谱查询、向量检索、节点/流程编排、Model Adapter 和多 Agent 运行时。

## 快速开始

### 1. 安装依赖

```bash
cd backend
pip install -r requirements.txt
```

Windows PowerShell：
```powershell
cd backend
.\install_dependencies.ps1
```

Windows CMD：
```bat
cd backend
install_dependencies.bat
```

### 2. 准备配置

#### 必需配置

```bash
cd backend
cp .env.example .env
cp model_adapter/configs/providers.yaml.example model_adapter/configs/providers.yaml
```

然后编辑：

- `.env`：Neo4j、Flask 端口、CORS 白名单、上传目录等运行时参数
- `model_adapter/configs/providers.yaml`：模型供应商与 API 密钥

#### 可选配置

- `config/yaml/config.yaml`：系统默认配置
- `agents/configs/agent_configs.yaml`：智能体列表与行为配置
- `mcp/configs/mcp_servers.yaml`：MCP 服务配置

### 3. 启动服务

```bash
cd backend
python app.py
```

默认运行在 `http://localhost:5000`

## 运行时环境变量

- `FLASK_HOST` / `FLASK_PORT`：后端监听地址与端口
- `FLASK_DEBUG` / `FLASK_USE_RELOADER`：开发模式与自动重载
- `CORS_ORIGINS`：逗号分隔的跨域白名单
- `UPLOAD_FOLDER`：上传目录，默认 `backend/uploads`
- `FRONTEND_DIST`：静态前端产物目录，默认 `../frontend/dist`

## 当前结构

```text
backend/
├── app.py
├── agents/
├── config/
├── mcp/
├── model_adapter/
├── nodes/
├── routes/
├── services/
├── tools/
├── vector_store/
└── workflows/
```

## 建议开发方式

- 通过 `python app.py` 启动，应用会先执行配置检查，再初始化 Neo4j / 向量库 / MCP 运行时
- 前端开发时，将 `frontend/.env` 或 `frontend-client/.env` 的代理地址指向本服务
- 不要把真实密钥提交到仓库；`.env`、`providers.yaml`、`agent_configs.yaml` 应保持本地化

## 相关文档

- `docs/configuration-guide.md`
- `docs/BACKEND_CONFIG_SURVEY.md`
- `docs/migration/VECTOR_STORE_MIGRATION.md`
- `backend/model_adapter/README.md`
- `backend/agents/README.md`
