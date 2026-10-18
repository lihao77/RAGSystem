---
status: current
audience: user
source: backend-core/src/core-app.ts, backend-local/src/main.ts
verified_at: 2026-07-28
---

# 安装与启动

## 前置条件

- Node.js 22.5 或更高版本
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

打开 `http://localhost:8080` 即可使用；不需要账号、安装向导或外部数据库。场景插件提供创建、切换、重命名和删除功能。

## 构建

```bash
npm run build:frontend
npm -w @ragsystem/backend-core run build
npm -w @ragsystem/backend-local run build
npm --prefix docs-site run build
```

## 下一步

- [核心概念](/01-concepts/)
- [系统上下文](/02-architecture/system-context)
- [配置指南](/03-guides/configuration)
- [Memory 使用与治理](/03-guides/memory)
- [部署模式与多租户](/06-operations/deployment)
