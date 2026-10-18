# 本地数据与存储

| 数据域 | 位置 |
|---|---|
| 场景目录、隐式身份、当前场景、控制设置 | RAG_DATA_ROOT/system/control.db |
| 会话、消息、Run、执行步骤、Outbox | `tenants/<scene-id>/db/ragsystem.db` |
| Provider、Agent、MCP 配置 | 场景 config/ |
| Memory 正式条目与候选 | 场景 memory/ Markdown 与 db/memory.db |
| Knowledge 元数据、向量与全文索引 | 场景 db/knowledge.db，SQLite + sqlite-vec |
| Skill 包 | 场景 skills/；内置包由插件提供 |
| 会话文件、工作目录、文件历史 | 场景 sessions/ 与 file-history/ 等目录 |
| Bot、Scheduler、Widget 控制数据 | 插件维护的本地控制库表 |

场景内部保留 tenantId 命名和目录结构，避免破坏历史引用。会话身份快照与配置加载继续遵循 backend-core/MIGRATIONS.md 的归一链。

备份完整 RAG_DATA_ROOT，并保证数据库与文件来自同一一致性快照。
