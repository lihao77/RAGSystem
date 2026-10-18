# 本地配置

配置由进程环境、启动目录的 .env 和场景运行时文件组成。入口为 `backend-core/src/config/env.ts`，进程环境优先于 .env。

| 变量 | 默认值 | 说明 |
|---|---|---|
| BACKEND_TS_HOST | 0.0.0.0 | HTTP 监听地址 |
| BACKEND_TS_PORT / PORT | 5002 | 端口，前者优先 |
| BACKEND_TS_LOG_LEVEL | info | 日志级别 |
| CORS_ORIGINS | 空 | 逗号分隔来源 |
| RAG_DATA_ROOT | ~/.ragsystem | 本地数据根目录 |
| BACKEND_PLUGIN_CONFIG | 产品 YAML | 自定义插件清单路径 |
| WIDGET_JWT_KEY_RING | 无 | 可选 Widget 接入密钥，与本地用户身份无关 |
| FRONTEND_DIST | 按启动目录解析 | 前端静态资源路径 |

部署、身份、执行和 UI 固定为 local；控制存储固定为 SQLite，文件存储固定为 filesystem。原有模式变量可省略。若保留 DEPLOYMENT_MODE / AUTH_MODE / EXECUTION_MODE / UI_MODE，必须为 local；CONTROL_STORAGE_MODE 必须为 sqlite，OBJECT_STORAGE_MODE 必须为 filesystem。不再接受 password、OIDC、远程部署、PostgreSQL 或 S3 模式值。

TENANCY_MODE 的 single/multi 与 STORAGE_MODE 的 sqlite/sqlite-per-tenant 仅保留本地配置表达；多场景能力由本地场景插件提供，不需要开启登录或切换部署模式。

## 运行时目录

全局场景目录和当前场景设置位于 `<RAG_DATA_ROOT>/system/control.db`。每个场景使用 `<RAG_DATA_ROOT>/tenants/<scene-id>/`，其中包含 db、config、memory、skills、sessions 和 file-history 等数据。现有场景 ID 与目录保持不变。

模型、Agent、MCP 与插件配置通过管理页面维护。系统启动会将历史控制库中的部署设置按形状归一为本地状态，同时保留当前场景和业务数据。

## 前端

VITE_DEV_PORT 默认 5174；VITE_API_PROXY_TARGET 默认 `http://localhost:5002`。首次进入无需安装或登录，GET /api/auth/me 返回当前场景的隐式用户。
