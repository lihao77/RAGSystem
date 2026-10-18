# Adapter 与依赖

依赖方向：backend-local 和功能插件依赖 backend-core 的契约；core 不导入具体产品或插件实现。

backend-local/main.ts 创建本地部署、加载 backend.plugins.yaml，再调用 buildCoreApp。LocalTenantRuntimeRegistry 按场景创建 Runtime，组合 SQLite、文件存储、配置服务和插件能力。

HTTP 路由经过隐式身份解析取得当前场景，再调用 application 接口。GET /api/auth/me 返回本地身份；场景管理由 local-scenes 插件提供。登录、安装和租户用户治理路由已移除。

插件通过能力注册表、宿主资源和领域事件协作。Memory、MCP、Knowledge、Skills、Scheduler、飞书与 Widget 各自管理本地存储；执行/文档工具可消费显式注入的沙箱能力，其代码位于 storage/sandbox。标准本地入口使用宿主执行。

原有 tenantId 字段、租约和会话 owner 校验保留，用于场景及外部 Widget/Bot 会话隔离。
