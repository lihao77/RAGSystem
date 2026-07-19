---
status: current
audience: developer
source: backend-ts/src/main.ts, backend-ts/src/app.ts, backend-ts/src/adapters, backend-ts/src/routes/route-options.ts
verified_at: 2026-07-19
---

# Adapter 与后端依赖关系

Adapter 是外部基础设施的具体实现。它不会自行处理 HTTP 请求，而是在 composition root 中创建或按请求解析，经 application contract 提供给路由和 Agent runtime。

## 依赖方向

```text
Transport (HTTP / WebSocket / Bot)
                |
                v
Application contracts and use cases
                |
                v
Repository / storage ports
                ^
                |
Local adapters -------- SaaS adapters
SQLite / Filesystem      PostgreSQL / Object Storage

Composition root: 选择、创建并连接以上各层
```

允许的源码依赖方向：

```text
routes ----------> contracts
application -----> contracts
adapters --------> contracts
composition -----> routes + application + adapters
```

`contracts/` 不依赖数据库、文件系统或具体 adapter。共享 application 不应根据 `STORAGE_MODE` 选择数据库；选择发生在 composition root。

## 各层职责

| 层级 | 当前位置 | 职责 |
|---|---|---|
| Transport | `routes/`、WebSocket、Bot/Widget routes | 鉴权、参数校验、状态码和响应映射 |
| Application contract | `contracts/*-application.ts` | 定义 Session、Memory、Artifact、Analytics、Monitoring 等用例能力 |
| Application | `services/memory/`、`services/runtime/*application.ts`、`services/sessions/` | 业务规则、租户用例和事务协调 |
| Adapter | `adapters/local/`、`adapters/saas/` | SQLite、文件系统、PostgreSQL、pgvector、S3-compatible Object Storage |
| Composition | `main.ts`、`app.ts`、`services/runtime/*runtime*.ts` | 根据部署配置创建实现、绑定 tenant、管理连接池与关闭顺序 |

## Adapter 在哪里生效

### Local

`LocalTenantRuntimeRegistry` 创建 `LocalRuntimeContainer`。后者构造 SQLite conversation store、本地 Memory/File History/Artifact、sqlite-vec 和宿主机工具。统一 resolver 没有收到 SaaS application 时，使用 `adapters/local` wrapper：

```text
LocalTenantRuntimeRegistry
  -> LocalRuntimeContainer
  -> SQLite / Filesystem service
  -> Local application adapter
  -> route
```

例如 `resolveSessionApplication()` 返回 `LocalSessionApplication`；Artifact、Analytics、Monitoring 也使用对应 Local adapter。Local Memory 使用文件条目和 SQLite candidate，但实现同一个异步 `MemoryApplication`。

### SaaS

`main.ts` 在 `STORAGE_MODE=postgres` 时创建：

- `SaaSMemoryRuntime`；
- `SaaSConversationRuntime`；
- S3-compatible Object Storage；
- 在 `CONTROL_STORAGE_MODE=postgres` 时创建 `SaaSControlRuntime`。

这些 runtime 创建 PostgreSQL repositories 和 Object Storage adapters，再向 `buildApp()` 注入 tenant-bound resolver：

```text
main.ts
  -> PostgreSQL / Object Storage adapters
  -> tenant-bound SaaS application
  -> RouteOptions resolver
  -> route / Agent runtime
```

`tenant_id` 在 SaaS application 或 repository 调用边界显式传入。Conversation、Run、Run Steps、Outbox、Memory、Artifact、Analytics、Knowledge metadata、pgvector、Session Files 和 File History 均使用租户约束。

## 示例：会话查询

```text
GET /api/agent/sessions
  -> SessionApplication.listSessions()
     -> LocalSessionApplication -> SQLite ConversationStore
     -> SaaSSessionApplication  -> PostgresConversationRepository
```

路由只依赖 `SessionApplication`，不根据部署模式拼 SQL 或访问文件路径。

## 示例：Artifact

```text
GET /api/artifacts/visualizations/:id
  -> ArtifactApplication.getVisualization()
     -> LocalArtifactApplication -> Local ArtifactService -> Filesystem
     -> SaaSArtifactService       -> PG metadata + Object Storage
```

会话 owner 校验在读取 Artifact 内容前执行。

## 当前仍需收口的边界

当前业务数据面已经完成主要分流，但后端还不是完全无状态的多实例 SaaS：

- `RuntimeContainer` 仍暴露若干 Local 具体类型；
- Agent 执行、实时事件 hub、部分后台任务仍有进程内状态；
- `routes` 中部分 Local fallback wrapper 尚未全部搬入独立 composition；
- 若干共享 Agent service 仍引用具体 SaaS repository 类型，应继续收窄为 ports；
- `main.ts` 和 `app.ts` 仍共同承担较多 composition 责任。

下一步目标是建立请求级 `applications` 集合，并拆分明确的 Local/SaaS composition：

```ts
request.applications = {
  sessions,
  memory,
  artifacts,
  analytics,
  monitoring,
  execution,
};
```

届时 route 不再逐个解析 resolver，Local/SaaS 的选择只发生一次。

