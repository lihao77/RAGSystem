# 本地部署与多场景

系统只有本地部署入口 `backend-local`，通过 `backend-core` 装配 Agent 内核和插件。数据使用 SQLite 与本地文件；无需账号注册、安装向导、外部数据库或对象存储。

## 启动

`npm run dev:backend-local` 启动开发后端。Docker 使用根目录 `docker compose up --build`，浏览器访问 `http://localhost:8080`。Electron 也使用相同本地后端。

## 场景

默认启用的 `backend-plugin-local-scenes` 支持创建、切换、重命名、删除场景。每个场景拥有独立配置、会话、知识库、记忆和运行时目录。隐式用户为 usr_local；默认场景为 tnt_local。内部继续使用 tenantId 表示场景，保持已有持久化引用。

当前场景记录在控制库的 local_active_tenant 设置中，身份提供者每次请求实时解析。当前场景无效或停用时回落默认场景。默认场景和当前活动场景不能删除；切换后才能删除其他场景。

## Runtime Registry

LocalTenantRuntimeRegistry 按场景取得或创建 Runtime，关闭时释放后台任务、连接和 SQLite 句柄。请求通过 registry 获取租约，业务路由不自行构造 Runtime。

本地身份具有宿主机操作能力；远程模型、MCP、飞书和 Widget 等可选集成仍然可用，其接入凭证与本地用户登录无关。
