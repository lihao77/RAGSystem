---
status: current
audience: developer, operator
source: backend-ts/src/app.ts, frontend-client/src, packages/*/src
verified_at: 2026-07-18
---

# 系统上下文

## 参与者

| 参与者 | 交互 |
|---|---|
| 终端用户 | 通过 Vue 聊天、知识库和配置页面发起请求 |
| 租户管理员 | 管理 Agent、Team、Provider、MCP、Widget 和成员 |
| 平台运维 | 管理租户、用户和 bot |
| 第三方站点 | 通过 `agent-widget` 创建会话并接收事件 |
| LLM/Embedding Provider | 提供生成和向量化能力 |
| MCP Server | 提供外部工具和 prompts |

## 系统边界

```text
外部用户/站点
      |
      v
frontend-client / agent-widget
      |
      v
backend-ts（身份、路由、Runtime、事件）
  |        |          |
 SQLite  sqlite-vec  LLM/MCP/Embedding
```

系统不把外部 Provider、MCP server 或浏览器宿主工具视为可信内部模块；它们通过 adapter、超时、权限和错误映射进入系统。
