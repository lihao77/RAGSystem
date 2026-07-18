---
status: current
audience: developer
source: backend-ts/src/app.ts, backend-ts/src/services/runtime/runtime-container.ts
verified_at: 2026-07-18
---

# 容器架构

## 容器

| 容器 | 责任 | 主要接口 |
|---|---|---|
| `frontend-client` | 页面、状态、HTTP/WS 客户端 | Browser |
| `backend-ts` | API、身份、Runtime 装配、静态 fallback | HTTP/SSE/WS |
| `TenantRuntimeRegistry` | 按租户缓存和关闭 Runtime | internal |
| `RuntimeContainer` | 业务服务和端口实现的 DI 图 | internal |
| SQLite stores | 会话、消息、文件、记忆、outbox | contract ports |
| sqlite-vec | 向量和知识库配置 | vector-store port |
| shared packages | 事件、协议、LLM 和 SDK | npm exports |

## 依赖方向

```text
routes -> services -> contracts -> stores/integrations
                         ^
                    runtime-container
```

路由不能越过 service 直接访问数据库或 Provider；共享包不能依赖 `backend-ts`。
