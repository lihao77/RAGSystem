# 管理端前端

`frontend/` 是后台管理端，基于 Vue 3、Vite、Element Plus 和 `vue-router`。

## 启动

```powershell
cd frontend
Copy-Item .env.example .env
npm install
npm run dev
```

默认地址：`http://localhost:8080`

## 环境变量

- `VITE_DEV_PORT`：开发端口，默认 `8080`
- `VITE_API_PROXY_TARGET`：后端地址，默认 `http://localhost:5000`
- `VITE_NEO4J_PROXY_TARGET`：Neo4j HTTP 地址，默认 `http://localhost:7474`

## 当前路由

定义文件：`src/router/index.js`

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

## 运行方式

- 通过 `vue-router` 使用 `createWebHistory()`
- 路由守卫会根据 `meta.requiresConfig` 调用配置检查逻辑
- `/api` 代理到后端
- `/neo4j` 代理到 Neo4j HTTP 服务

## 主要目录

- `src/views/`：页面
- `src/router/`：路由
- `src/api/`：接口封装
- `src/composables/`：复用状态与逻辑
- `src/components/`：通用组件

## 对接后端

- 页面配置：`/api/config`
- 节点：`/api/nodes`
- 工作流：`/api/workflows`
- 文件：`/api/files`
- 图谱 / GraphRAG：`/api/search`、`/api/graphrag`、`/api/visualization`
- 向量：`/api/vector`、`/api/vector-library`
- Model Adapter：`/api/model-adapter`
- MCP：`/api/mcp`
- Agent 配置：`/api/agent-config`
