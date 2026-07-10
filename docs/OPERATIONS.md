# 运行说明 / Operations Guide

## 当前主链路 / Mainline

日常开发与 CI 使用 `backend-ts`、`frontend-client` 和根 npm workspace。需要 Node.js 24+。

```bash
npm ci
cp backend-ts/.env.example backend-ts/.env
cp frontend-client/.env.example frontend-client/.env
```

Windows PowerShell 可使用 `Copy-Item` 代替 `cp`。

### 后端 / Backend

```bash
cd backend-ts
npm run dev
```

- 默认地址：`http://localhost:5002`
- 配置：`BACKEND_TS_HOST`、`BACKEND_TS_PORT`、`PORT`、`RAG_DATA_ROOT`、`BACKEND_TS_DB_PATH`
- 默认数据根目录：`~/.ragsystem`
- 若存在 `frontend-client/dist`，后端会托管前端构建产物

### 前端 / Frontend

```bash
cd frontend-client
npm run dev
```

- 默认地址：`http://localhost:5174`
- `/api` 与 WebSocket 默认代理到 `http://localhost:5002`
- 可通过 `VITE_DEV_PORT` 和 `VITE_API_PROXY_TARGET` 覆盖

Windows 下也可在仓库根目录运行 `start_server.bat` 同时启动两个开发服务。

## 运行时配置 / Runtime Configuration

正式配置位于 `<data-root>/config`，默认 `<data-root>` 为 `~/.ragsystem`：

- `app/config.yaml`
- `agents/team_index.yaml`
- `agents/teams/*.yaml`
- `model_adapter/providers.yaml`
- `vector_store/vectorizers.yaml`
- `mcp/mcp_servers.yaml`
- `daemon/daemon.yaml`

模型 Provider、Agent Team、MCP、向量化器与守护 Agent 配置可通过前端管理页面维护。不要提交真实密钥或本地运行时配置。

## 验证 / Verification

```bash
npm run check:packages
npm run check:backend
npm run check:frontend
npm run check:widget
```

后端门禁包含生产与脚本类型检查、完整测试和生产构建。前端门禁包含测试与构建；widget 门禁包含源码/测试类型检查和所有发布产物构建。

## 桌面安装包 / Desktop Installer

`desktop-electron` 与开发环境共用 TypeScript 后端，不需要 Python 或 PyInstaller。构建会先生成 backend bundle，并使用 Electron Node 模式实际启动它，验证 `node:sqlite`、`sqlite-vec` 和健康接口：

```bash
cd desktop-electron
npm install
npm run build:installer
```

桌面安装包默认使用 `http://127.0.0.1:5002`，运行时数据继续写入 `~/.ragsystem`。

## 常用接口 / Common Endpoints

- `POST /api/agent/stream`：启动执行
- `/api/agent/sessions/{session_id}/ws`：实时通道
- `POST /api/agent/execute`：同步执行
- `GET /api/agent/execution/overview`：执行概览
- `/monitor`：监控页面
- `/team-builder`：Team 编排
- `/agent-config`：Agent 配置
- `/mcp`：MCP 管理
- `/vector-library`：向量库管理
