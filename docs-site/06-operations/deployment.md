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

Local 多租户模式下 `TenantRuntimeRegistry` 按 tenant 获取或创建 `RuntimeContainer`。每个 Runtime 拥有自己的：

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

`STORAGE_MODE=postgres` 和 `DATABASE_URL` 启用 PostgreSQL Memory、Conversation、Run、Run Steps、Outbox、Knowledge metadata、pgvector、Artifact metadata、Analytics、Session File metadata 和 File History metadata。大文件及可视化内容进入 S3-compatible Object Storage。会话历史、执行状态、Memory 管理和文件 API 已通过 tenant-bound application facade 使用这些数据源。

Control Plane 使用独立的 `CONTROL_STORAGE_MODE`、`CONTROL_DATABASE_URL` 和 `CONTROL_SECRET_MASTER_KEY`，不会隐式复用 Memory 的连接配置。`docker-compose.saas.yml` 默认 `CONTROL_STORAGE_MODE=postgres`。PostgreSQL Control runtime 已包含 Bot/Widget adapter、secret envelope、cron lease 和共享 JWT key ring；缺少 URL 或 32-byte master key 时启动会 fail-fast。

仓库提供独立的 SaaS 测试 compose。它使用 PostgreSQL、pgvector 和 MinIO，不与默认 Local compose 混用：

```powershell
$env:SESSION_JWT_SECRET="replace-with-a-long-random-secret"
docker compose -f docker-compose.saas.yml up --build
```

打开 `http://localhost:8080`，通过安装向导创建管理员和默认租户。停止并保留数据使用：

```bash
docker compose -f docker-compose.saas.yml down
```

提交前可运行自动化 Compose 验收。脚本使用独立 project、随机密钥和空闲端口，验证 health/readiness、双租户会话与 Memory 隔离、附件上传下载与 ObjectStorage 隔离，以及 backend 重启后的 PostgreSQL/MinIO 持久性；成功或失败后默认删除测试 volume：

```bash
npm run e2e:saas-compose
```

复用已构建镜像可添加 `-- --no-build`，需要保留失败现场时添加 `-- --keep`。

Memory 管理页面为 `http://localhost:8080/memory`。查看 PostgreSQL：

```powershell
docker compose -f docker-compose.saas.yml exec postgres psql -U ragsystem -d ragsystem
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
| `ragsystem-saas-postgres` | PostgreSQL Control、Memory、Conversation、Run、Outbox、Knowledge metadata 和向量 |
| `ragsystem-saas-object-storage` | MinIO 中的 Knowledge、Artifact、附件、File History 和 workspace blob |
| `ragsystem-saas-data` | 容器运行期数据；不作为 SaaS 业务数据的持久化主存储 |

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

当前代码不保证跨进程共享内存事件 hub，也不自动提供 Kubernetes 编排。PostgreSQL/Object Storage 是持久化事实来源；Cron 与 BackgroundTask 已使用租约防止重复领取，但 Agent 执行 runtime、实时连接投影、飞书 webhook route token 和长连接仍有进程内状态。SaaS 部署在 route resolver、leader lease 和 pub/sub 完成前必须只运行一个 Daemon leader。上线前应以 `/readyz`、备份恢复、租户隔离和多实例执行测试作为验收条件。
