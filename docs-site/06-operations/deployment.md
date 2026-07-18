# 部署模式与多租户

本页描述当前源码已经支持的 profile 选择和身份边界。不要把历史迁移路线图当作已实现功能。

## 当前配置轴

| 轴 | 值 | 来源 |
|---|---|---|
| deployment | `local` / `saas` / `enterprise` | `DEPLOYMENT_MODE` |
| auth | `local` / `password` / `oidc` | `AUTH_MODE` |
| tenancy | `single` / `multi` | `TENANCY_MODE` |
| execution | `local` / `docker` / `remote` | `EXECUTION_MODE` |
| storage | `sqlite` / `sqlite-per-tenant` / `postgres` | `STORAGE_MODE` |
| control storage | `sqlite` / `postgres` | `CONTROL_STORAGE_MODE` |
| ui | `local` / `saas` | `UI_MODE` |

配置先由环境变量 seed，再由系统配置覆盖，最终通过 `resolveDeploymentProfile()` 校验。`saas + local execution` 默认拒绝，除非显式允许不安全执行。

## 身份与租户边界

`RequestIdentity` 至少包含 tenant、user、role、身份类型。普通业务进入 Tenant Runtime；控制面进入 admin/platform scope；Widget 请求使用独立 identity，并将 app key 写入 session metadata。资源服务在 session owner 检查后才返回数据，跨租户访问通常伪装为 404。

## Runtime Registry

多租户模式下 `TenantRuntimeRegistry` 按 tenant 获取或创建 `RuntimeContainer`。每个 Runtime 拥有自己的：

- SQLite conversation/file/memory 连接；
- knowledge vector store（默认 `dataRoot/db/knowledge.db`，测试 `:memory:` 除外）；
- Agent 配置、MCP、Provider 和 outbox dispatcher；
- 后台任务、实时事件 hub 和权限策略。

Runtime 关闭时必须停止 dispatcher、外部连接和 SQLite；不能在请求处理器中自行 new Runtime。

## 部署建议

### Local

单进程、`AUTH_MODE=local`、SQLite、前端 Vite 或后端静态 fallback，适合开发和桌面端。

默认 Docker compose 即 Local 模式：

```bash
docker compose up --build
```

### SaaS

多租户、password/OIDC、docker/remote execution、显式 CORS、强 session secret；生产不使用宿主机代码执行。

当前可通过 `STORAGE_MODE=postgres` 和 `DATABASE_URL` 启用 PostgreSQL Memory。该模式只替换 Memory，Control、Conversation、Run、Outbox、Knowledge 和文件仍依赖 SQLite/本地目录，因此是单节点 Hybrid，不是完整 SaaS 存储。

Control Plane 使用独立的 `CONTROL_STORAGE_MODE`、`CONTROL_DATABASE_URL` 和 `CONTROL_SECRET_MASTER_KEY`，不会隐式复用 Memory 的连接配置。当前 `docker-compose.saas.yml` 明确默认 `CONTROL_STORAGE_MODE=sqlite`。PostgreSQL Control runtime 已包含 Bot/Widget adapter、secret envelope、cron lease 和共享 JWT key ring；缺少 URL 或 32-byte master key 时启动会 fail-fast。

仓库提供独立的 Hybrid SaaS 测试 compose。它使用独立的 Local 数据卷和 PostgreSQL 数据卷，不与默认 Local compose 混用：

```powershell
$env:SESSION_JWT_SECRET="replace-with-a-long-random-secret"
docker compose -f docker-compose.saas.yml up --build
```

打开 `http://localhost:8080`，通过安装向导创建管理员和默认租户。停止并保留数据使用：

```bash
docker compose -f docker-compose.saas.yml down
```

Memory 管理页面为 `http://localhost:8080/memory`。查看 PostgreSQL：

```powershell
docker exec -it ragsystem-saas-postgres psql -U ragsystem -d ragsystem
```

`docker-compose.saas.yml` 的开发默认连接参数：

```text
Host: localhost
Port: 5432
Database: ragsystem
Username: ragsystem
Password: ragsystem
```

这些凭证只适合本机测试。生产环境必须改用 secret 管理、独立账号和最小权限，并取消不必要的宿主机端口暴露。

#### 数据卷

| Volume | 内容 |
|---|---|
| `ragsystem-saas-postgres` | PostgreSQL Memory |
| `ragsystem-saas-data` | Control SQLite、tenant SQLite、配置、知识库和文件 |

不要只备份其中一个 volume。

Compose 会传入 `CONTROL_DATABASE_URL` 和可选的 `CONTROL_SECRET_MASTER_KEY`。SaaS runtime 直接使用 PostgreSQL Control schema；系统开发阶段不提供 Local SQLite 到 PostgreSQL 的数据迁移兼容层。缺少 master key 时会启动失败。

### Enterprise

在 SaaS 基础上使用企业身份、PostgreSQL、受控网络出口和外部对象存储。

## 数据目录

```text
RAG_DATA_ROOT/
├─ db/ragsystem.db              # conversation、session、outbox 等
├─ db/knowledge.db              # 向量和知识库配置
├─ db/knowledge-uploads/        # 源文件 blob
├─ tenants/                     # 租户运行时数据
├─ system/                      # 系统配置
├─ config/                      # MCP、Provider、daemon 等 YAML
└─ skills/                      # skill 来源
```

## 明确的非目标

当前代码不保证跨进程共享内存事件 hub，也不自动提供 Kubernetes 编排。`STORAGE_MODE=postgres` 只代表 PostgreSQL Memory driver 已启用，不能推导出其他数据域已经迁移。上线前应检查对应 service/factory，并以 `/readyz`、备份恢复和租户隔离测试作为验收条件。
