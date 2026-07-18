# 存储模型

本章梳理 RAGSystem 的当前存储架构。Local 模式以 SQLite、sqlite-vec 和文件系统为主；`STORAGE_MODE=postgres` 已可将 Memory 切换到 PostgreSQL，但其他数据域仍使用 Local 存储，因此属于 Hybrid 模式。项目不使用传统 ORM。

## 存储总览

| 数据域 | 文件 | Store 接口 | 实现 |
|--------|------|-----------|------|
| 会话/消息/任务/metrics/widget_tokens | `<dataRoot>/db/ragsystem.db` | `IConversationStore` | `conversation-store/` |
| 向量 + 知识库配置 + 知识库文件元数据 | `<dataRoot>/db/knowledge.db` | `IVectorStore` + `IKnowledgeConfig` | `sqlite-vec-driver` |
| 上传源文件 blob | `<dataRoot>/db/knowledge-uploads/` | 知识库文件面 | `sqlite-vec-driver` |
| 文件索引 | （共享 dbPath） | `IFileIndexStore` | `file-index-service` |
| 文件历史 | （dataRoot 下纯文件） | `IFileHistoryStore` | `file-history-service` |
| 记忆 | Local：dataRoot 下文件；Hybrid：PostgreSQL | `MemoryRepository` | `MemoryStore` / `PostgresMemoryRepository` |
| Control/Identity | `<RAG_DATA_ROOT>/system/control.db` | `ControlPlane` 组合 ports | `SqliteControlPlaneAdapter` |
| widget 凭证 | （共享 dbPath） | `WidgetCredentialStore` | `widget-credential-store` |

::: tip 无 ORM
全项目**无传统 ORM**（无 Prisma/TypeORM/Sequelize）。Local stores 使用 `node:sqlite`；PostgreSQL Memory adapter 使用 `pg` 和显式 SQL，并由 repository contracts 隔离实现。
:::

## 契约层（contracts/）

存储契约是后端的脊柱，每个域定义独立接口：

```
contracts/
├── control-plane/          # tenant/user/membership/settings/session/audit 异步端口
├── conversation-store/     # 会话存储（含消息/任务/metrics 操作接口）
├── file-history-store/     # 文件历史
├── file-index-store/       # 文件索引
├── memory-store/           # 记忆
└── vector-store/           # 向量存储
    ├── (driver-registry)   # 多驱动注册
    ├── (embedder)          # 嵌入器接口
    └── (knowledge-config)  # 知识库配置面
```

这种设计使存储实现可替换——例如 `vector-store` 通过 `driver-registry` 支持多驱动，当前唯一实现是 `sqlite-vec`。

Control Plane 消费者统一使用异步端口。当前 `SqliteControlPlaneAdapter` 包装现有 `ControlStore`，路由不再访问 `.db`；这只是 PostgreSQL adapter 的前置边界，不代表 Control 数据已经离开 SQLite。Bot 和 Widget 仍共享 `control.db` 的外键关系，后续切库必须作为同一关系域处理或先正式拆分端口。

Control Plane 的存储配置与 Memory 分离：`CONTROL_STORAGE_MODE` / `CONTROL_DATABASE_URL` 只属于控制面，`STORAGE_MODE` / `DATABASE_URL` 只属于 Memory。当前 Local 与 SaaS Hybrid 都实际使用 SQLite Control Plane。PostgreSQL schema、migration、repository adapter 可以独立验证，但 app composition 在 Bot config 和 Widget credential 完成同源迁移前拒绝启用 PostgreSQL Control Plane。

## SQLite 句柄管理

`createRuntimeContainer` 创建多个独立 SQLite 句柄，**共享同一 `dbPath`**（WAL 模式允许并发连接）：

| Store | 用途 | 句柄 | close 顺序 |
|-------|------|------|-----------|
| `conversationStore` | 主库（最底层） | 独立 | 最后 |
| `fileIndex` | 文件索引 | 独立 | 先于 conversationStore |
| `vectorStore` | knowledge.db（独立文件） | 独立 | `vectorLibrary.close()` |
| `widgetCredentialStore` | widget token（仅启用时） | 独立 | `widgetCredentialStore.close()` |

::: tip 关键事实
`vectorStore` 同一对象同时实现 `IVectorStore`（数据面）+ `IKnowledgeConfig`（配置面），共享 `knowledge.db` 单一连接。主库 `ragsystem.db` **不涉及**向量/配置面（`runtime-container.ts:156-162`）。
:::

Local `memoryStore` 和 `fileHistory` 为纯文件存储，无 SQLite 句柄。PostgreSQL Memory 的 tenant facade 不持有资源也不缓存；应用级 runtime handle 持有连接池，关闭顺序为先关闭 tenant runtimes，再关闭连接池。

## PostgreSQL Memory Hybrid

当 `STORAGE_MODE=postgres` 时，启动必须提供 `DATABASE_URL` 或 `POSTGRES_URL`。后端执行 Memory schema migration，并将同一个 tenant-bound SaaS provider 注入治理路由、Memory tools 和 Agent context。

此配置不会迁移 ControlStore、conversation、run、outbox、knowledge、vector 或文件存储，也不提供完整多实例 SaaS。完整演进顺序见 [Local 与 SaaS 分离迁移路线](./local-saas-migration-roadmap)。

当前 PostgreSQL Memory schema version 为 4，覆盖：

- active/archived entry；
- publish/archive candidate 和审核 claim；
- tenant/scope revision；
- 旧 session/user/workspace candidate 的幂等自动发布迁移。

Memory 管理接口对所有角色都执行个人数据边界：admin/owner 也只能通过通用 entry API 看到自己的个人 Memory和租户共享 Memory。

## close 顺序

容器关闭时（`runtime-container.ts:251-266`）按依赖逆序释放：

```
outboxDispatcher.stop()
  → widgetCredentialStore?.close()
  → mcp.close()
  → daemon.close()
  → vectorLibrary.close()
  → fileIndex.close()
  → conversationStore.close()   # 最底层，最后
```

## sqlite-vec 驱动

`services/vector-store/sqlite-vec/sqlite-vec-driver.ts` 是唯一向量驱动。

### 关键行为

| 行为 | 出处 |
|------|------|
| `knowledge.db` 默认路径 `<dataRoot>/db/knowledge.db` | `sqlite-vec-driver.ts:767` |
| 上传 blob 根 `<dataRoot>/db/knowledge-uploads` | `sqlite-vec-driver.ts:84` |
| 旧 `vectors.db` 检测与告警（不再引用） | `sqlite-vec-driver.ts:778` |
| `:memory:` 模式走临时库（测试用） | `runtime-container.ts:151-154` |

### 不降级原则

sqlite-vec 是**唯一向量源**。driver 模块加载失败（vec0 不可用、Node/Windows ABI 不兼容）会**直接抛错**让启动报错，而非静默降级到无向量的空检索（`runtime-container.ts:146-147`）。应用层降级路径已被删除。

## 配置驱动的存储选择

`runtime-container.ts:150-155` 读取 `systemConfig.getVectorStoreConfig()` 决定向量后端：

```ts
const vectorStoreConfig = systemConfig.getVectorStoreConfig();
const resolvedVectorStoreConfig =
  options.dbPath === ":memory:"
    ? { ...vectorStoreConfig, sqlite_vec: { ...vectorStoreConfig.sqlite_vec, database_path: ":memory:" } }
    : vectorStoreConfig;
const vectorStore = createVectorStoreFromConfig(resolvedVectorStoreConfig, options.dataRoot);
```

`createVectorStoreFromConfig`（`vector-store-factory.ts`）据 config 实例化 driver，触发 driver 模块自注册。

## widget 凭证存储

`widgetCredentialStore`（`runtime-container.ts:119-121`）仅在配置 `WIDGET_JWT_SECRET` 时实例化：

- 复用同一 `dbPath`，独立句柄
- 存储 widget token，带周期清理（`startPruning()`，跟随 outboxDispatcher 生命周期）
- close 时单独释放

## 数据目录布局

完整运行时数据目录结构详见 [运行时数据目录](/03-guides/runtime-data-layout)。
