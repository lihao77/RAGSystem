# 前端使用指南

仓库当前有两个前端：

- `frontend/`：后台管理端
- `frontend-client/`：对话与监控端

## 管理端

启动：

```powershell
cd frontend
npm run dev
```

默认地址：`http://localhost:8080`

环境变量：

- `VITE_DEV_PORT`
- `VITE_API_PROXY_TARGET`
- `VITE_NEO4J_PROXY_TARGET`

路由来源：`frontend/src/router/index.js`

当前页面：

- `/`
- `/split`
- `/search`
- `/settings`
- `/nodes`
- `/workflow`
- `/files`
- `/graphrag`
- `/vector-service`
- `/model-adapter`
- `/mcp`
- `/agent-config`

说明：

- 需要配置检查的页面由路由 `meta.requiresConfig` 控制
- `/api` 请求通过 Vite 代理到后端
- `/neo4j` 请求通过 Vite 代理到 Neo4j Browser HTTP 端口

## 对话端

启动：

```powershell
cd frontend-client
npm run dev
```

默认地址：`http://localhost:5174`

环境变量：

- `VITE_DEV_PORT`
- `VITE_API_PROXY_TARGET`

页面切换来源：`frontend-client/src/App.vue`

当前路径：

- `/` 或 `/chat`
- `/monitor` 或 `/agent-monitor`
- `/agent-config`
- `/mcp`

说明：

- 使用浏览器 History API 和 `window.location.pathname` 做轻量路由
- 监控页和聊天页依赖 `/api/agent/stream`、`/api/agent/execution/overview`、诊断与审批接口
- 聊天页会把前端选中的 `selected_llm` 传给后端流式执行接口

## 调试

- 看浏览器 Network 确认 `/api` 是否命中代理
- 看后端日志确认 4xx/5xx 来源
- 看 SSE 连接是否成功建立到 `/api/agent/stream`
