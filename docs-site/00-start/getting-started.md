---
status: current
audience: user
source: backend-core/src/core-app.ts, backend-local/src/main.ts, backend-saas/src/main.ts
verified_at: 2026-07-28
---

# 安装与启动

## 前置条件

- Node.js 24 或更高版本
- npm 10 或更高版本
- 可选：用于远程 LLM、Embedding 或 MCP 的网络访问

## 安装

```bash
npm install
```

必须在仓库根目录安装，workspace 包会自动链接。

## 启动后端

```bash
npm run dev:backend-local
```

默认监听 `0.0.0.0:5002`。验证：

```bash
curl http://localhost:5002/livez
curl http://localhost:5002/readyz
```

## 启动前端

```bash
npm -w frontend-client run dev
```

联调 TS 后端时设置 `VITE_API_PROXY_TARGET=http://localhost:5002`。

## Docker 启动 Local

根目录的 `docker-compose.yml` 是 Local 模式：

```powershell
docker compose up -d --build
```

## Docker 启动 SaaS

`docker-compose.saas.yml` 会启动 PostgreSQL、SaaS backend 和 frontend。必须先设置至少 32 字符的 session secret：

```powershell
$env:SESSION_JWT_SECRET="replace-with-a-long-random-secret"
docker compose -f docker-compose.saas.yml up -d --build
```

启动后：

| 服务 | 地址 |
|---|---|
| 前端 | `http://localhost:8080` |
| Backend | `http://localhost:5002` |
| PostgreSQL | `localhost:5432` |
| MinIO API | `http://localhost:9000` |
| MinIO Console | `http://localhost:9001` |

第一次打开前端时，通过安装向导创建管理员和默认租户。查看容器：

```powershell
docker compose -f docker-compose.saas.yml ps
docker logs --tail 200 ragsystem-saas-backend
```

::: warning 多实例边界
SaaS compose 的主要业务数据已经使用 PostgreSQL、pgvector 和 MinIO，包括 Control、Memory、Conversation、Run、Outbox、Knowledge、Artifact、Session Files 和 File History。Agent 进程内 runtime、实时事件和部分后台任务仍有单节点语义，因此不能仅凭存储切换宣称已经支持任意水平扩容。
:::

## 构建

```bash
npm run build:frontend
npm -w @ragsystem/backend-core run build
npm -w @ragsystem/backend-local run build
npm -w @ragsystem/backend-saas run build
npm --prefix docs-site run build
```

## 下一步

- [核心概念](/01-concepts/)
- [系统上下文](/02-architecture/system-context)
- [配置指南](/03-guides/configuration)
- [Memory 使用与治理](/03-guides/memory)
- [部署模式与多租户](/06-operations/deployment)
