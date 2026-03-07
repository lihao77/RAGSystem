# 后台管理前端

基于 Vue 3 + Vite + Element Plus 的后台管理端，负责系统配置、图谱查询、流程编排、向量库和模型管理。

## 快速开始

```bash
cd frontend
cp .env.example .env
npm install
npm run dev
```

默认启动地址：`http://localhost:8080`

## 环境变量

- `VITE_DEV_PORT`：开发端口，默认 `8080`
- `VITE_API_PROXY_TARGET`：后端 API 地址，默认 `http://localhost:5000`
- `VITE_NEO4J_PROXY_TARGET`：Neo4j Browser / HTTP 代理地址，默认 `http://localhost:7474`

## 目录结构

- `src/views`：页面视图
- `src/components`：复用组件
- `src/api`：接口封装
- `src/router`：路由配置
- `src/composables`：组合式逻辑

## 备注

如果你仍在使用 `src/config.example.js` / `src/config.js` 方式配置，请优先迁移到 `.env`，避免端口和代理信息分散在多个文件里。
