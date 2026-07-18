# 配置参考

配置分为三层：进程环境变量、`RAG_DATA_ROOT` 下的 YAML/JSON 运行时配置，以及租户/Agent 的业务配置。解析入口是 `backend-ts/src/config/env.ts`，未知环境变量会被 schema 丢弃。

## 1. 加载优先级

```text
process.env（最高）
  > cwd/.env（只补充不存在的键）
  > schema 默认值
```

`.env` 由后端手动读取，不支持 Vite 的完整 dotenv 语法；空行和 `#` 注释跳过，首尾引号去除。生产环境建议通过进程管理器或容器注入 secret。

## 2. 环境变量完整清单

| 变量 | 默认值 | 可选值/格式 | 作用 |
|---|---|---|---|
| `BACKEND_TS_HOST` | `0.0.0.0` | host | HTTP 监听地址 |
| `BACKEND_TS_PORT` | `5002` | 1-65535 | 监听端口，优先于 `PORT` |
| `PORT` | 无 | 1-65535 | 端口回退 |
| `BACKEND_TS_LOG_LEVEL` | `info` | pino level | 日志级别 |
| `CORS_ORIGINS` | 空=全开 | 逗号分隔 URL | CORS 白名单 |
| `RAG_DATA_ROOT` | `~/.ragsystem` | 绝对/相对路径 | 数据、配置、上传和租户根目录 |
| `WIDGET_JWT_KEY_RING` | 未启用 | JSON key ring | 启用 Widget app/JWT |
| `SESSION_JWT_SECRET` | 未启用 | secret | `AUTH_MODE=password` 的 session token |
| `SESSION_TOKEN_TTL_HOURS` | `168` | 正数 | session JWT TTL |
| `DEPLOYMENT_MODE` | `local` | local/saas/enterprise | 部署 profile |
| `AUTH_MODE` | `local` | local/password/oidc | 身份认证方式 |
| `TENANCY_MODE` | `single` | single/multi | 单租户/多租户 |
| `EXECUTION_MODE` | `local` | local/docker/remote | 工具/代码执行位置 |
| `STORAGE_MODE` | `sqlite` | sqlite/sqlite-per-tenant/postgres | 存储 profile |
| `CONTROL_STORAGE_MODE` | `sqlite` | sqlite/postgres | Control Plane 存储选择；当前 app composition 仅开放 sqlite |
| `CONTROL_DATABASE_URL` | 无 | PostgreSQL connection URL | `CONTROL_STORAGE_MODE=postgres` 的独立连接串，不复用 Memory 配置 |
| `CONTROL_SECRET_MASTER_KEY` | 无 | base64 encoded 32-byte key | PostgreSQL Control v2 envelope 的独立主密钥；不得由数据库密码或 JWT secret 派生 |
| `WIDGET_JWT_KEY_RING` | 无 | JSON key ring | 可选的共享 Widget JWT active/previous key 配置；签发使用 active，验证允许未过期 previous |
| `DATABASE_URL` | 无 | PostgreSQL connection URL | PostgreSQL Memory 连接串 |
| `POSTGRES_POOL_MAX` | `10` | 正整数 | PostgreSQL Memory pool 上限 |
| `UI_MODE` | `local` | local/saas | 前端运行模式 |
| `ALLOW_UNSAFE_LOCAL_EXECUTION` | `false` | true/false | 允许 SaaS profile 使用宿主机执行 |

### Profile 约束

`DEPLOYMENT_MODE=saas` 且 `EXECUTION_MODE=local` 时，如果没有显式设置 `ALLOW_UNSAFE_LOCAL_EXECUTION=true`，启动会失败。这是安全门禁，不是建议项。

`CONTROL_STORAGE_MODE` 与 `STORAGE_MODE` 是两个独立选择轴。前者只控制 tenant/user/membership/settings/auth session/audit 等 Control Plane 数据，后者当前控制 Memory。Local 未设置 `CONTROL_STORAGE_MODE` 时始终使用 SQLite。

PostgreSQL Control Plane 的 schema、Bot/Widget adapter、cron lease 和 AES-GCM envelope 已有独立边界。启用 `CONTROL_STORAGE_MODE=postgres` 时必须同时提供 `CONTROL_DATABASE_URL` 与独立的 `CONTROL_SECRET_MASTER_KEY`。系统开发阶段不提供 Local 数据导入兼容，使用 PostgreSQL 时直接初始化当前 schema。

设置 `WIDGET_JWT_KEY_RING` 后，格式为 `{"active":{"kid":"v2","secret":"..."},"previous":[{"kid":"v1","secret":"...","expiresAt":4102444800}]}`。所有实例必须使用同一 ring。

## 3. 常用配置组合

### 本地开发

```dotenv
BACKEND_TS_PORT=5002
RAG_DATA_ROOT=./.ragsystem
DEPLOYMENT_MODE=local
AUTH_MODE=local
TENANCY_MODE=single
EXECUTION_MODE=local
STORAGE_MODE=sqlite
CONTROL_STORAGE_MODE=sqlite
```

### SaaS 最小基线

```dotenv
DEPLOYMENT_MODE=saas
AUTH_MODE=password
TENANCY_MODE=multi
EXECUTION_MODE=docker
STORAGE_MODE=sqlite-per-tenant
CONTROL_STORAGE_MODE=sqlite
SESSION_JWT_SECRET=replace-with-random-secret
WIDGET_JWT_KEY_RING={"active":{"kid":"v1","secret":"replace-with-a-32-byte-secret"},"previous":[]}
CORS_ORIGINS=https://console.example.com
```

## 4. 运行时配置文件

路径均相对 `RAG_DATA_ROOT`，可由 `SystemConfigService` 查看/更新的配置以 `/api/system-config/schema` 为准：

| 文件/目录 | 消费模块 | 内容 |
|---|---|---|
| `system/config.yaml` 或 app config | `SystemConfigService` | memory、tools、vector、document extraction |
| `config/model_adapter/providers.yaml` | `ModelAdapterService` | Provider endpoint、model、能力和密钥引用 |
| `config/mcp/mcp_servers.yaml` | `McpService` | MCP server、transport、自动连接 |
| `config/daemon/daemon.yaml` | `DaemonService` | 守护任务 |
| `config/agents/` | `AgentConfigService` | Agent/Team YAML |
| `skills/` | `SkillLibraryService` | builtin/workspace/user skill |

不同版本的路径由 service 派生，升级时应以 `/api/system-config/schema` 和源码默认值为准，不要复制旧 `.env.example`。

## 5. 前端变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `VITE_DEV_PORT` | `5174` | Vite 开发端口 |
| `VITE_API_PROXY_TARGET` | `http://localhost:5001` | 开发代理；连接 TS 后端必须改为 `http://localhost:5002` |

## 6. Secret 与安全

不要把 `SESSION_JWT_SECRET`、`WIDGET_JWT_KEY_RING`、Provider API key 写入仓库或 YAML 明文。CORS 默认全开只适合本机；生产必须设置白名单。Widget 的 publishable key 可暴露，但 secret、JWT 签发和 WS ticket 必须留在服务端。
