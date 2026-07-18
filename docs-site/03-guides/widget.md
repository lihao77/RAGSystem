---
status: current
audience: developer
source: backend-ts/src/routes/widget.ts, packages/agent-widget/src
verified_at: 2026-07-18
---

# Widget 集成

Widget 由 `@ragsystem/agent-widget` 提供 Web Component/bridge；后端通过 `/api/widget` 创建会话和签发 WebSocket ticket。启用前设置 `WIDGET_JWT_KEY_RING`，生产环境配置 app allowed origins。

相关页面：[Widget API](/04-api/http#widget-与-ag-ui)、[Widget 包架构](/05-sdk/shared-packages)。
