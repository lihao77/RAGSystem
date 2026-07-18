# HTTP 路由清单

本清单以 `backend-ts/src/app.ts` 的注册为准。未在下表出现的路径不属于当前 TS API。

## 探针与启动

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| GET | `/livez` | 公开 | 进程存活，不创建租户 Runtime |
| GET | `/readyz` | 公开 | 控制库、迁移和启动就绪 |
| GET | `/api/bootstrap` | 公开 | 安装/初始化状态 |
| POST | `/api/install` | 一次性 | 初始化本地实例 |

`/readyz` 会通过 Control Plane health port 检查数据库连接和实际 schema version。成功响应的 `checks` 包含 `control_database`、`migrations` 和 `control_schema_version`；连接失败或 schema 版本落后时返回 `503`。Control Plane driver 由 app composition 决定，不能从 Memory 的 `STORAGE_MODE` 推断。

## 认证 `/api/auth`

`POST /login`、`POST /install`、`POST /switch-tenant`、`GET /me`、`POST /logout`。具体可用动作由 `AUTH_MODE` 决定；password 模式需要 `SESSION_JWT_SECRET`。

## 租户业务

| 前缀 | 主要路径 | 作用 |
|---|---|---|
| `/api` | `GET /health` | 当前租户健康和 Runtime 状态 |
| `/api/artifacts` | CRUD/下载端点 | 持久和临时产物 |
| `/api/agent-config` | configs、teams、presets、tools、memory-metadata、mcp-servers、skills | Agent/Team 配置 |
| `/api/memory` | entries、candidates、admin/candidates | 正式 Memory、个人候选和共享审核；详见 [Memory API](./memory) |
| `/api/skills` | `GET /`、`GET /:name`、文件读写、创建/更新/删除 | Skill 库 |
| `/api/model-adapter` | provider-types、providers、order、test | Provider 配置和连通性 |
| `/api/system-config` | schema、GET/PATCH `/`、reload | 系统配置 |
| `/api/mcp` | registry/install、servers、tools、prompts | MCP 服务器和能力 |
| `/api/knowledge-bases` | upload、file-status、index、search、vectorizers、rerankers、collections、health、migrate | RAG 知识库 |
| `/api/embedding-models` | `GET /models` | Embedding 模型 |

## Agent `/api/agent`

| 模块 | 路径 | 说明 |
|---|---|---|
| agents | `GET /agents`、`POST /agents/create`、`POST /agents/reload` | Agent 生命周期 |
| execution | `POST /execute`、`POST /collaborate` | 非流式执行和 Team 协作 |
| stream | `POST /stream`、`POST /stream/stop` | SSE 流式执行和停止 |
| sessions | `POST /sessions`、`GET /sessions` | 创建和查询会话 |
| monitoring | `GET /metrics`、`POST /metrics/reset`、`GET /event-outbox`、retry/delete、`GET /context-snapshot` | 运行观测和 outbox 管理 |
| analytics | token-trend、model-usage、activity-heatmap、daily-activity | 聚合分析 |
| files | session files、file changes | 会话附件和变更历史 |
| runtime-core | 运行时核心和 pending interaction | 中断恢复 |
| websocket | `/sessions/:sessionId/ws` | 单次 ticket 后建立实时连接 |

## 控制面

| 前缀 | 端点 | 权限 |
|---|---|---|
| `/api/admin` | tenants、tenant members 增删改 | platform/admin |
| `/api/platform` | tenants、users、bots 查询 | platform operator |
| `/api/bots` | bot 创建和管理 | tenant admin |
| `/api/widget/apps` | app、secret rotate、revoke、tokens、audit | tenant admin/owner |

## Widget 与 AG-UI

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/widget/auth/token` | app key/secret 换 15 分钟 JWT |
| POST | `/api/widget/sessions` | JWT 或 publishable key 创建 session |
| POST | `/api/widget/sessions/:id/ws-ticket` | 签发 60 秒单次 WS ticket |
| POST | `/api/agui` | AG-UI SSE/interrupt 网关 |

未配置 `WIDGET_JWT_KEY_RING` 时 Widget 端点返回 `503 widget_disabled`。

## 不再提供的旧路径

当前 `app.ts` 未注册 `/api/vector`、`/api/permissions` 和旧的 `/api/agent/health`。权限策略由 Runtime 内部 `PermissionPolicyService` 执行，向外暴露的管理端点是否恢复需以新的路由注册和测试为准；不要继续在客户端新增这些旧路径调用。

## 响应和错误

普通业务响应通常为 `{ success: true, data, message }`；Widget/control 端点可能返回 `{ success: true, app }` 等命名字段。统一错误状态码和鉴权规则见 [接口约定](./conventions)，实时协议见 [WebSocket 与事件](./websocket-events)。
