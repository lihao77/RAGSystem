---
status: current
audience: operator
verified_at: 2026-07-18
---

# 故障排查

| 现象 | 首先检查 |
|---|---|
| 进程存活但不能接流量 | `/readyz`、启动迁移、控制库 |
| 知识库启动失败 | sqlite-vec ABI、`knowledge.db`、Embedding Provider |
| Agent 无事件 | outbox pending/failed、dispatcher、WebSocket ticket |
| Widget 503 | `WIDGET_JWT_SECRET` 是否设置 |
| 跨域失败 | `CORS_ORIGINS` 和 Widget allowed origins |
| 工具被拒绝 | tenant role、PermissionPolicy、path approval |
| `POST /api/agent/stream` 立即 400 | 查看错误 body；请求只能包含当前严格 schema 字段，旧 `use_v2` 已移除 |
| 首次打开租户页面出现 `ERR_MODULE_NOT_FOUND` | 检查 `sqlite-vec-linux-x64/arm64` 是否进入 backend 镜像 |
| 前端 Docker `npm ci` 报内部 workspace 包 404 | frontend Docker build context 必须是 monorepo 根目录 |
| Memory 写入后索引为空 | 区分个人直接发布与共享 candidate；检查 `published` / `pending_review` |

## Docker 诊断

```powershell
docker compose -f docker-compose.saas.yml ps
docker logs --tail 200 ragsystem-saas-backend
docker inspect --format "{{.State.Health.Status}}" ragsystem-saas-backend
```

健康检查成功只说明启动依赖可用。租户 Runtime 是惰性创建的，还应登录后验证：

```text
GET /api/agent/sessions
GET /api/model-adapter/providers
GET /api/memory/entries
```

## Memory 数据诊断

```sql
SELECT scope, name, status FROM memory_entries ORDER BY updated_at DESC;
SELECT scope, name, operation, status FROM memory_candidates ORDER BY updated_at DESC;
SELECT version, name FROM ragsystem_memory_schema_migrations ORDER BY version;
```

- 个人写入应在 `memory_entries` 中立即出现，并留下 approved candidate 审计。
- team/agent 写入在审核前只出现在 `memory_candidates`，状态为 candidate。
- schema version 4 会自动发布旧策略遗留的个人 publish candidates。

完整流程见 [Memory 使用与治理](/03-guides/memory)。
