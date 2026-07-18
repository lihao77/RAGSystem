# 当前路由矩阵

本页只记录 `backend-ts/src/app.ts` 当前注册的前缀，具体 schema 和业务说明见 [HTTP API](./http)。

## 注册域

| 身份域 | 前缀 | 注册模块 | 默认鉴权 |
|---|---|---|---|
| Probe | `/livez`、`/readyz` | `health.ts` | 公开 |
| Bootstrap/install | `/api/bootstrap`、`/api/install` | `bootstrap.ts`、`install.ts` | 公开/一次性 |
| Auth | `/api/auth` | `auth.ts` | auth mode |
| Tenant runtime | `/api` | health、artifacts、agent-config、memory、skills、model-adapter、system-config、mcp、knowledge-bases、embedding-models | tenant identity |
| Agent runtime | `/api/agent` | agents、execution、stream、sessions、session-files、monitoring、analytics、runtime-core、WS | tenant + owner |
| AG-UI | `/api/agui` | `agent/agui.ts` | tenant 或 widget identity |
| Control plane | `/api/admin` | `admin.ts` | admin/owner |
| Platform | `/api/platform` | `platform.ts` | platform operator |
| Bots | `/api/bots` | `bots.ts` | tenant/admin |
| Widget console | `/api/widget/apps` | `widget-apps.ts` | tenant admin/owner |
| Widget public | `/api/widget` | `widget.ts` | JWT 或 publishable key |

## 能力索引

### Agent

`GET /api/agent/agents`、`POST /api/agent/agents/create`、`POST /api/agent/agents/reload` 管理 Agent；`POST /api/agent/execute`、`/collaborate` 启动执行；`POST /api/agent/stream`、`/stream/stop` 提供流式执行；`POST/GET /api/agent/sessions` 管理会话。会话附件、文件变更、metrics、event outbox、context snapshot 和 analytics 均在 `backend-ts/src/routes/agent/`。

### 知识库

`/api/knowledge-bases` 承载文件上传、索引、file-status、vectorizers、rerankers、collections、search、health、migrate；`/api/embedding-models/models` 提供 Embedding 模型目录。

### 管理与配置

| 前缀 | 能力 |
|---|---|
| `/api/model-adapter` | provider-types、providers、order、test |
| `/api/mcp` | registry/install、servers、tools、prompts |
| `/api/agent-config` | configs、teams、presets、tools、memory-metadata、mcp-servers、skills |
| `/api/system-config` | schema、GET/PATCH config、reload |
| `/api/skills` | skill 列表、详情、文件上传和删除 |
| `/api/memory` | entries、个人 candidates 与 team/agent 管理员审核；详见 [Memory API](./memory) |

### Widget

启用 `WIDGET_JWT_SECRET` 后：`POST /api/widget/auth/token` 用 app secret 换短期 JWT，`POST /api/widget/sessions` 创建会话，`POST /api/widget/sessions/:id/ws-ticket` 签发一次性 WS ticket；`/api/widget/apps` 管理 app、secret、token 和 audit。

## 维护规则

修改 `app.ts` 注册、子路由 `app.METHOD` 或身份 scope 时，在仓库根目录运行 `npm --prefix docs-site run build` 并更新本页。
