# 知识库与向量检索

知识库负责文档向量化、存储与语义检索。本章基于 `backend-ts/src/services/knowledge/knowledge-base-service.ts`、`services/vector-store/`、`contracts/knowledge-base.ts` 与 `routes/knowledge-base.ts`。HTTP 约定见 [接口约定](/04-api/conventions)。

## 存储架构

知识库使用**自包含的单一 SQLite 文件 + 物理 blob 目录**：

```
<RAG_DATA_ROOT>/db/
├── knowledge.db              # 向量 + vectorizer/reranker 配置面（同一连接）
└── knowledge-uploads/        # 上传源文件 blob 存储
```

::: tip 出处
- `knowledge.db` 路径：`sqlite-vec-driver.ts:767` → `path.join(dataRoot, "db", "knowledge.db")`
- `knowledge-uploads/`：`sqlite-vec-driver.ts:84` → `path.join(config.dataRoot, "db", "knowledge-uploads")`
- 配置面与文件面共享 `knowledge.db` 单一连接（`runtime-container.ts:156-162`），主库 `ragsystem.db` 不涉及向量/配置面。
:::

::: warning sqlite-vec 是唯一向量源
driver 模块加载失败（vec0 不可用、Node/Windows ABI 不兼容）会**直接抛错**让启动报错，而非静默降级到无向量的空检索（见 `runtime-container.ts:146-147` 注释）。
:::

## 三层配置：vectorizer / reranker / embedding

知识库检索质量由三层配置决定：

### Vectorizer（向量化器）

把文档转为向量。每个 vectorizer 有独立配置（embedding 模型、分块策略等）。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/vectorizers` | 列出所有向量化器 |
| `POST` | `/vectorizers` | 添加向量化器（body 走 `VectorizerCreateSchema`） |
| `POST` | `/vectorizers/:key/activate` | 激活指定向量化器 |
| `GET` | `/vectorizers/:key/docs` | 列出该向量化器下的文档 |
| `DELETE` | `/vectorizers/:key` | 删除向量化器 |

### Reranker（重排序器）

对检索结果二次排序，提升相关性。

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/rerankers` | 列出所有重排序器 |
| `POST` | `/rerankers` | 添加（body 走 `RerankerCreateSchema`） |
| `GET` | `/rerankers/:key` | 获取详情 |
| `POST` | `/rerankers/:key/activate` | 激活 |
| `DELETE` | `/rerankers/:key` | 删除 |

::: warning 重排序器校验
`model` 模式的重排序器必须提供 `provider_key` 和 `model_name`，否则报错（路由层将其映射为 500）。
:::

## 文件索引管理（路由前缀 `/api/knowledge-bases`）

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/file-status` | 查询文件索引状态 |
| `POST` | `/index-file` | 索引单个文件（body 走 `IndexFileRequestSchema`） |
| `POST` | `/delete-file` | 删除已索引文件（无对应分块时返回 404） |
| `POST` | `/migrate` | 执行迁移操作（body 走 `GenericVectorRequestSchema`） |

## 文件上传（路由前缀 `/api/knowledge-bases`）

文件上传走单独的路由模块 `routes/knowledge-base-files.ts`（在 `app.ts` 中以同一前缀 `/api/knowledge-bases` 注册）。上传文件物理存储到 `knowledge-uploads/`，元数据与向量进 `knowledge.db`。

::: tip 上传限制
`app.ts:127-132`：multipart 限制 `fileSize = max_content_length`（来自系统配置）、`files` 数量上限 20。
:::

## Embedding 模型

`EmbeddingModelService`（`runtime-container.ts:164`）管理嵌入模型，路由前缀 `/api/embedding-models`。它复用 `vectorLibrary` 的配置面。

## 在运行时中的角色

```
VectorLibraryService（runtime-container.ts:158-162）
  ├─ vectorStore       → IVectorStore（数据面：读写向量）
  ├─ knowledgeConfig   → IKnowledgeConfig（配置面：vectorizer/reranker）
  └─ knowledgeFileStore → 知识库文件面（上传源文件 blob）
```

三者共享 `knowledge.db` 单一连接。Agent 的知识检索工具（`tools/KnowledgeTools`）通过 `vectorLibrary` 执行查询。

## 与共享包的关系

向量驱动基于 `sqlite-vec` npm 包（`backend-ts/package.json` 依赖 `sqlite-vec ^0.1.9`），结合 `node:sqlite` 原生绑定。Embedding 调用复用 `@ragsystem/agent-llm` 的 provider 适配。
