---
status: current
audience: user, administrator, developer
source: backend-ts/src/tools/MemoryTools, backend-ts/src/routes/memory.ts, frontend-client/src/views/MemoryManager.vue
verified_at: 2026-07-18
---

# Memory 使用与治理

Memory 用于保存会影响后续 Agent 上下文的信息，例如用户偏好、项目约束、长期目标和团队规则。它不同于聊天历史：聊天历史记录发生过什么，Memory 记录以后应继续采用什么。

## 进入管理页面

登录后打开：

```text
http://localhost:8080/memory
```

管理页面包含四个视图：

| 视图 | 内容 |
|---|---|
| 我的记忆 | 当前用户的 session、user、workspace 活跃 Memory |
| 共享记忆 | 当前租户已经发布的 team、agent Memory |
| 待审核 | 创建者自己的共享候选；管理员还可看到租户共享审核队列 |
| 历史 | 已归档 entry，以及本人已批准、拒绝或撤回的候选记录 |

页面支持名称/内容搜索、scope 筛选、详情查看、候选编辑/撤回和归档。管理员或所有者可以批准、拒绝共享候选，并发起共享 Memory 的归档申请。

管理页面同时支持两种部署模式：

| 模式 | 正式 Memory 来源 | 候选与审核来源 |
|---|---|---|
| Local | `dataRoot/memory` 下的 Markdown 文件 | Local SQLite |
| SaaS | PostgreSQL `memory_entries` | PostgreSQL `memory_candidates` |

前端使用同一组 `/api/memory` 接口。后端通过部署适配器列出和归档正式 Memory，不会让页面直接读取文件系统或数据库。

## 个人与共享

| 分类 | Scope | 可见范围 | 写入行为 |
|---|---|---|---|
| 个人 | `session` | 当前会话 | 直接发布 |
| 个人 | `user` | 当前用户的所有会话 | 直接发布 |
| 个人 | `workspace` | 当前用户在指定工作区的会话 | 直接发布 |
| 共享 | `team` | 使用该 Team 的租户成员和 Agent | 先保存私人候选，审核后共享 |
| 共享 | `agent` | 使用指定 Agent 的租户运行 | 先保存私人候选，审核后共享 |

管理员不能通过通用管理接口读取其他用户的个人 Memory。通用 `/entries` 只返回当前用户的个人条目和租户共享条目；未来若需要合规审计，应使用独立权限和独立审计接口。

## 让 Agent 写入 Memory

Agent 配置必须允许相应 scope：

1. 打开“Agent 配置”。
2. 在“记忆”区域启用读取、写入或归档 scope。
3. 确认 `write_memory`、`list_memory_index`、`read_memory_entry`、`archive_memory` 工具可用。

可以明确要求 Agent：

```text
请记住：我偏好简洁的中文回答，保存到 user Memory。
```

个人 scope 成功结果包含：

```json
{
  "saved": true,
  "published": true,
  "candidate_id": "audit-candidate-id",
  "memory_id": "active-memory-id",
  "scope": "user"
}
```

共享 scope 成功结果包含 `pending_review: true`。审核前，候选只对创建者可见，但创建者可以通过 Memory 工具读取、修改或撤回；其他成员不会收到该候选的上下文注入。

## 审核流程

```text
write_memory(team/agent)
  -> private candidate
  -> 管理员领取审核
  -> approve / reject
  -> approved: active shared entry
```

批准操作使用乐观版本 `expected_version`。如果候选已经被修改、领取或处理，接口返回 `409 conflict`，页面会要求刷新后重试。

个人 scope 不进入管理员审核。系统仍保留一条 `approved` candidate 作为写入审计记录，但活跃内容立即进入 `memory_entries`。

## 归档

- 个人 Memory：本人确认后直接归档。
- team/agent Memory：管理员发起归档候选，审核通过后归档。
- 归档记录保留在历史中，不再出现在活跃索引和 Agent 自动注入中。

归档操作携带 entry 的 `expected_version`，避免从旧页面覆盖已经变化的数据。

Local 模式返回短的 opaque entry ID。该 ID 只用于管理 API 定位当前用户可见的 Markdown 条目，不是文件名或文件路径。服务端会再次校验 user/session 可见性；其他用户的个人 Memory 不会因为知道 ID 而变得可访问。

## PostgreSQL 中的数据

Hybrid SaaS 模式下，Memory 位于 PostgreSQL：

| 表 | 作用 |
|---|---|
| `memory_entries` | 活跃和已归档的正式 Memory |
| `memory_candidates` | 写入/归档候选及审核审计 |
| `memory_scope_revisions` | scope 版本，用于上下文缓存失效 |
| `ragsystem_memory_schema_migrations` | Memory schema 迁移版本 |

进入数据库：

```powershell
docker exec -it ragsystem-saas-postgres psql -U ragsystem -d ragsystem
```

常用查询：

```sql
SELECT tenant_id, scope, name, status, updated_at
FROM memory_entries
ORDER BY updated_at DESC;

SELECT tenant_id, scope, name, operation, status, owner_user_id
FROM memory_candidates
ORDER BY updated_at DESC;

SELECT version, name
FROM ragsystem_memory_schema_migrations
ORDER BY version;
```

::: tip saved: true 的含义
个人 scope 表示已经发布；共享 scope 表示私人候选已经持久化。判断是否进入共享索引，应同时检查 `published` 或 `pending_review`。
:::

## 旧候选迁移

PostgreSQL Memory schema version 4 会幂等迁移旧策略留下的 session、user、workspace publish candidates：

- 创建对应 active entry；
- 将 candidate 标记为 `approved`；
- 保留 candidate 作为审计记录；
- 更新 scope revision；
- 不自动发布 team/agent candidates。

## 当前限制

当前 SaaS 是 Hybrid：

- Memory 使用 PostgreSQL；
- Control、身份、会话、消息、配置、知识库和文件仍主要使用租户 SQLite/本地目录；
- Memory 管理页的 Active Entry 查询面向 PostgreSQL Memory；
- 还不能把当前形态视为无状态、可横向扩容的完整 SaaS。

Local 模式的 Memory 管理页已经可以列出个人和共享的正式条目、查看历史、直接归档个人条目，以及为 team/agent 创建归档审核候选。Local 与 SaaS 使用各自的 runtime 和存储，不提供跨模式数据导入兼容。

API 请求和响应见 [Memory API](/04-api/memory)，部署边界见 [部署模式与多租户](/06-operations/deployment)。
