---
status: current
audience: developer, operator
source: backend-ts/src/services/runtime/runtime-container.ts, backend-ts/src/services/stores
verified_at: 2026-07-18
---

# 数据与存储

| 数据域 | Local | Hybrid SaaS |
|---|---|---|
| Control、身份、租户设置 | `<RAG_DATA_ROOT>/system/control.db` | 同左，仍是 SQLite |
| conversation/session/run/outbox | tenant `db/ragsystem.db` | 同左，仍是 SQLite |
| Agent/Team/Provider/MCP 配置 | tenant 数据目录和配置文件 | 同左，仍是本地持久化 |
| Memory entries/candidates/revisions | 文件系统和 SQLite candidates | PostgreSQL |
| knowledge/vector/config | tenant `db/knowledge.db` | 同左，使用 sqlite-vec |
| knowledge source blob | tenant `db/knowledge-uploads/` | 同左，本地文件 |

Hybrid SaaS 的 PostgreSQL 表为 `memory_entries`、`memory_candidates`、`memory_scope_revisions` 和 `ragsystem_memory_schema_migrations`。个人 Memory 直接发布；team/agent Memory 经过候选审核。详见 [Memory 使用与治理](/03-guides/memory)。

主库和知识库在 Runtime 中分工明确；`dbPath=:memory:` 时知识库也走内存库。Hybrid 备份必须同时保存 PostgreSQL、SaaS data volume 和知识库源文件 blob，单独备份 PostgreSQL 不能恢复完整租户。
