# 多 Agent 客户端

基于 Vue 3 + Vite 的多 Agent 对话与监控前端，包含聊天、任务监控、Agent 配置和 MCP 管理页面。

## 快速开始

```bash
cd frontend-client
cp .env.example .env
npm install
npm run dev
```

默认启动地址：`http://localhost:5174`

## 环境变量

- `VITE_DEV_PORT`：开发端口，默认 `5174`
- `VITE_API_PROXY_TARGET`：后端 API 地址，默认 `http://localhost:5000`

## 当前页面

- `/chat`：多 Agent 对话
- `/agent-monitor`：执行监控
- `/agent-config`：Agent 配置
- `/mcp`：MCP 管理

## 说明

当前客户端仍使用轻量级手写路由切换；后续适合迁移到 `vue-router`，以便支持更稳定的导航、懒加载和权限控制。
