# 对话与监控前端

`frontend-client/` 是面向聊天、执行监控和 Agent/MCP 管理的轻量前端，基于 Vue 3 + Vite。

## 启动

```powershell
cd frontend-client
Copy-Item .env.example .env
npm install
npm run dev
```

默认地址：`http://localhost:5174`

## 环境变量

- `VITE_DEV_PORT`：开发端口，默认 `5174`
- `VITE_API_PROXY_TARGET`：后端地址，默认 `http://localhost:5000`

## 当前路径

页面切换定义在 `src/App.vue`：

- `/` 或 `/chat`
- `/monitor` 或 `/agent-monitor`
- `/agent-config`
- `/mcp`

## 路由实现

- 不使用 `vue-router`
- 通过 `window.location.pathname`、`history.pushState()` 和 `popstate` 实现页面切换
- `App.vue` 会给页面注入 `selectedLLM`、主题和导航事件

## 对接后端

- 对话执行：`POST /api/agent/stream`
- 同步执行：`POST /api/agent/execute`
- 流控：`POST /api/agent/stream/stop`、`POST /api/agent/stream/reconnect`
- 审批：`POST /api/agent/sessions/<session_id>/approvals/<approval_id>/respond`
- 监控：`GET /api/agent/execution/overview`、任务状态和诊断接口
- Agent 配置：`/api/agent-config`
- MCP：`/api/mcp`

## 主要目录

- `src/views/`：聊天、监控、Agent 配置、MCP 页面
- `src/components/`：消息、执行树、审批、图表、地图相关组件
- `src/api/`：Agent、监控、MCP 请求
- `src/styles/`：样式
