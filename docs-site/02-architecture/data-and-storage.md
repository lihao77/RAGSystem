---
status: current
audience: developer, operator
source: backend-ts/src/services/runtime/local-runtime-container.ts, backend-ts/src/services/runtime/saas-conversation-runtime.ts
verified_at: 2026-07-19
---

# 数据与存储

| 数据域 | Local | SaaS |
|---|---|---|
| Control、身份、租户设置 | `<RAG_DATA_ROOT>/system/control.db` | PostgreSQL Control runtime |
| Conversation、Session、Run、Run Steps、Outbox | tenant `db/ragsystem.db` | PostgreSQL，显式 `tenant_id` 约束 |
| Provider/MCP 控制数据 | tenant 配置文件 | PostgreSQL metadata + secret resolver |
| Memory entries/candidates/revisions | 文件系统和 SQLite candidates | PostgreSQL |
| Knowledge metadata/vector | tenant `db/knowledge.db`、sqlite-vec | PostgreSQL metadata + pgvector |
| Knowledge、Artifact、附件、File History blob | tenant 本地目录 | S3-compatible Object Storage |
| Analytics | Local conversation store 聚合 | PostgreSQL tenant analytics repository |

SaaS Memory 的核心表为 `memory_entries`、`memory_candidates`、`memory_scope_revisions` 和 `ragsystem_memory_schema_migrations`。个人 Memory 直接发布；team/agent Memory 经过候选审核。详见 [Memory 使用与治理](/03-guides/memory)。

Conversation、Run、Outbox、Artifact、Knowledge、Session File 和 File History 都通过 tenant-bound repository/application 访问。`saas_runs` 和 `saas_run_steps` 使用 tenant 组合键或 tenant 查询条件，不能只依赖全局 ID 隔离。

Local 主库和知识库在 Runtime 中分工明确；`dbPath=:memory:` 时知识库也走内存库。SaaS 备份必须同时保存 PostgreSQL 和 Object Storage，单独备份任一侧不能恢复完整租户。

持久化迁移完成不等于 API 节点已经完全无状态。Agent 执行 runtime、实时事件 hub 和部分后台任务仍有进程内投影或单节点语义；多实例部署还需要 queue、lease 和 pub/sub 边界。

完整 Adapter 调用关系见 [Adapter 与后端依赖关系](./adapter-and-dependencies)。
