# ADR-001：Tenant Runtime 作为隔离边界

## 决策

按 tenant 获取 `RuntimeContainer`，由 registry 管理创建、缓存和关闭。路由只从当前请求的 container 获取 service。

## 原因

会话、工具、Provider、MCP、权限、事件和数据库必须在同一租户上下文中运行，避免请求级拼装导致越租户访问。

## 代价

Runtime 数量随租户增长；需要明确关闭、空闲回收和跨进程部署策略。
