---
status: current
audience: frontend developer, backend developer, integrator
source: backend-ts/src/routes/memory.ts
verified_at: 2026-07-18
---

# Memory HTTP API

Memory API 前缀为 `/api/memory`。所有路由要求 tenant identity；普通查询至少需要 member，审核路由至少需要 admin。

成功分页响应：

```json
{
  "success": true,
  "data": {
    "items": [],
    "total": 0,
    "limit": 50,
    "offset": 0,
    "has_more": false
  }
}
```

## Entry

### GET /api/memory/entries

列出当前用户可见的正式 Memory。

| Query | 类型 | 默认值 | 说明 |
|---|---|---:|---|
| `scope` | string | 全部 | 逗号分隔：`session,user,workspace,team,agent` |
| `status` | enum | 全部 | `active` 或 `archived` |
| `search` | string | 空 | 搜索 name、description、content，最长 200 |
| `limit` | integer | 50 | 1-200 |
| `offset` | integer | 0 | 大于等于 0 |

可见性规则：

- `team/agent`：租户共享，成员可见；
- `user`：`scope_id` 必须是当前 user ID；
- `workspace`：分区中的 user ID 必须是当前用户；
- `session`：session 必须属于当前用户；
- admin/owner 也不会通过本接口看到其他用户的个人 Memory。

示例：

```http
GET /api/memory/entries?scope=user,workspace&status=active&limit=50
Authorization: Bearer <session-token>
```

### POST /api/memory/entries/:id/archive

归档正式 Memory。

```json
{
  "expected_version": 1
}
```

行为：

- session/user/workspace：本人直接归档，返回 `data.status = "archived"`；
- team/agent：仅 admin/owner 可发起，返回 `data.status = "candidate"`；
- entry 版本不匹配返回 `409 conflict`；
- 不存在或无权访问统一返回 `404`。

## 创建者候选

### GET /api/memory/candidates

只查询当前用户创建的候选。

| Query | 可选值 |
|---|---|
| `status` | `candidate`、`approved`、`rejected`、`withdrawn` |
| `target_scope` | `team`、`session`、`agent`、`workspace`、`user` |
| `operation` | `publish`、`archive` |
| `limit` | 1-200，默认 50 |
| `offset` | 默认 0 |

### PATCH /api/memory/candidates/:id

创建者编辑尚未领取的 candidate。SaaS 模式必须提供 `expected_version`。

```json
{
  "expected_version": 1,
  "name": "Updated name",
  "description": "Updated summary",
  "content": "Updated body",
  "why": null,
  "how_to_apply": "Use this rule for reviews."
}
```

至少提供一个修改字段。候选已被审核者领取或版本过期时返回 `409`。

### DELETE /api/memory/candidates/:id

创建者撤回 candidate。DELETE 请求携带 JSON body：

```json
{
  "expected_version": 2
}
```

## 管理员审核

管理员接口只处理 team/agent 候选，个人 Memory 不进入管理员审核。

### GET /api/memory/admin/candidates

查询租户共享审核队列。Query 与创建者候选一致，但 `target_scope` 只接受 `team` 或 `agent`；不传时默认同时查询二者。

### POST /api/memory/admin/candidates/:id/claim

领取候选，避免多个审核者并发处理：

```json
{
  "expected_version": 1,
  "claim_ttl_seconds": 900
}
```

`claim_ttl_seconds` 范围为 1-86400。成功返回 `review_claim_token` 和递增后的 candidate version。

### POST /api/memory/admin/candidates/:id/approve

批准发布或归档：

```json
{
  "expected_version": 2,
  "review_claim_token": "optional-existing-claim-token",
  "comment": "approved"
}
```

未传 claim token 时，接口先自动领取再批准。还可在未领取时同时传 `name`、`description`、`content` 修订发布内容。

发布批准在一个 PostgreSQL 事务内完成：

1. 锁定并验证 candidate/version/claim；
2. 创建 active entry，或归档目标 entry；
3. 将 candidate 标记为 approved；
4. 增加 scope revision。

### POST /api/memory/admin/candidates/:id/reject

```json
{
  "expected_version": 2,
  "review_claim_token": "optional-existing-claim-token",
  "comment": "reason"
}
```

未传 claim token 时同样会自动领取。成功后 candidate 状态变为 `rejected`。

## 状态机

```text
publish candidate: candidate -> approved -> active entry
                  candidate -> rejected
                  candidate -> withdrawn

archive candidate: candidate -> approved -> archived entry
                  candidate -> rejected
                  candidate -> withdrawn
```

个人 Memory 的自动发布/归档仍保留 approved candidate 审计行，但不会进入管理员队列。

## 错误

| HTTP | code | 常见原因 |
|---:|---|---|
| 400 | `invalid_request` | scope 非法、个人 candidate 进入管理员接口、缺少 expected_version |
| 401 | `unauthorized` | session token 缺失、过期或撤销 |
| 403 | `forbidden` | 角色不足 |
| 404 | `not_found` | 跨租户、无权访问、entry/candidate 不存在 |
| 409 | `conflict` | 乐观版本过期、候选已领取、状态已变化 |

全局响应约定见 [接口约定](./conventions)，认证入口见 [HTTP 路由清单](./http)。
