# 本地存储模型

系统使用 node:sqlite、sqlite-vec、YAML 和文件系统，不依赖外部数据库或对象存储。存储通过领域接口注入，业务路由不直接选择数据库。

全局控制库管理场景与隐式身份；每个场景有独立会话库和插件数据。详细路径见 [数据与存储](./data-and-storage)。

SQLite 连接由创建它的运行时拥有，关闭顺序为插件、场景运行时、全局控制库。使用 registry 请求租约避免关闭仍在使用的场景。

Memory 正式条目保存在 Markdown 中，候选与审核记录使用 SQLite；Skills 使用本地目录包和幂等中断恢复；Knowledge 使用 SQLite 全文检索与 sqlite-vec。

任何持久化形状变化都要覆盖加载归一、历史夹具与幂等检查，登记到 backend-core/MIGRATIONS.md。
