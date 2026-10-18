# 本地运行与维护

## 启动与探针

`npm ci` 安装依赖，`npm run build:backend` 构建后端，`npm -w @ragsystem/backend-local run start` 启动。开发使用 `npm run dev:backend-local`。

GET /readyz 检查控制库和 schema；GET /livez 检查存活；GET /api/health 检查当前场景运行时。

## 备份

停止写入后备份完整 RAG_DATA_ROOT（默认 ~/.ragsystem），包括 system/control.db、plugins 清单和全部 tenants 场景目录。仅备份 SQLite 文件不能保留配置、Skill、Memory Markdown、上传文件和文件历史。恢复时保持目录与数据库来自同一快照。

## 验证与升级

运行 npm run check:packages、npm run check:backend、npm run check:frontend 与 npm run check:widget。部署前验证 Node.js、node:sqlite、sqlite-vec 的 ABI 与启动探针。现有控制设置在加载时幂等归一为本地模式；场景 ID 和已有数据目录继续使用。

BACKEND_TS_LOG_LEVEL 控制日志级别。Agent metrics、context snapshot、outbox 与 WebSocket 用于运行诊断。
