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
| Widget 503 | `WIDGET_JWT_KEY_RING` 是否设置 |
| 跨域失败 | `CORS_ORIGINS` 和 Widget allowed origins |
| 工具被拒绝 | tenant role、PermissionPolicy、path approval |
| `POST /api/agent/stream` 立即 400 | 查看错误 body；请求只能包含当前严格 schema 字段，旧 `use_v2` 已移除 |
| 首次打开租户页面出现 `ERR_MODULE_NOT_FOUND` | 检查 `sqlite-vec-linux-x64/arm64` 是否进入 backend 镜像 |
| 前端 Docker `npm ci` 报内部 workspace 包 404 | frontend Docker build context 必须是 monorepo 根目录 |
| Memory 写入后索引为空 | 区分个人直接发布与共享 candidate；检查 `published` / `pending_review` |

## Docker 诊断

```powershell
docker compose ps
docker logs --tail 200 ragsystem-backend
docker inspect --format "{{.State.Health.Status}}" ragsystem-backend
```

健康检查成功只说明启动依赖可用。租户 Runtime 是惰性创建的，还应验证当前场景：

```text
GET /api/agent/sessions
GET /api/model-adapter/providers
GET /api/memory/entries
```

## Memory 数据诊断

检查当前场景 memory/ 下的 Markdown 正式条目，以及 db/memory.db 的 memory_candidates。个人写入直接更新文件；team/agent 候选在批准后发布。

完整流程见 [Memory 使用与治理](/03-guides/memory)。
