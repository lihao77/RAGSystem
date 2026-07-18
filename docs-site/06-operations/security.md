---
status: current
audience: operator
source: backend-ts/src/identity, backend-ts/src/routes, backend-ts/src/config/env.ts
verified_at: 2026-07-18
---

# 安全基线

- 生产显式设置 `CORS_ORIGINS`。
- 强随机设置 `SESSION_JWT_SECRET`，并配置 `WIDGET_JWT_KEY_RING`。
- SaaS 不使用宿主机 local execution。
- Widget secret 只在服务端保存，publishable key 配合 Origin 白名单。
- 工具默认人工审批，限制 Bash/代码执行路径、超时和输出。
- 备份和恢复必须同时覆盖 SQLite 数据库与知识源 blob。
