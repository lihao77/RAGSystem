# Frontend Client

中文 | [English](#english)

`frontend-client/` 是 RAGSystem 的 Vue 3 前端，提供聊天、执行监控、Agent 配置、MCP 管理、向量库和模型提供方管理界面。

## 开发启动 / Development

```bash
cp .env.example .env
npm install
npm run dev
```

默认端口为 `http://localhost:5174`，`/api` 会代理到 `http://localhost:5001`。

## 主要页面 / Main pages

- `/` 或 `/chat/:id?` — 聊天页面
- `/monitor`、`/agent-monitor` — 执行监控
- `/agent-config` — Agent 配置
- `/mcp` — MCP 管理
- `/vector-library` — 向量库管理
- `/model-providers` — 模型提供方管理

## 构建 / Build

```bash
npm run build
```

更多实现细节请查看 [docs/architecture.md](docs/architecture.md)。

---

## English

`frontend-client/` is the Vue 3 frontend for RAGSystem. It provides the chat UI, execution monitoring, agent configuration, MCP management, vector library management, and model provider management.

### Development

```bash
cp .env.example .env
npm install
npm run dev
```

The dev server runs on `http://localhost:5174` by default and proxies `/api` to `http://localhost:5001`.

### Main pages

- `/` or `/chat/:id?` — chat
- `/monitor`, `/agent-monitor` — execution monitoring
- `/agent-config` — agent configuration
- `/mcp` — MCP management
- `/vector-library` — vector library management
- `/model-providers` — model provider management

### Build

```bash
npm run build
```

See [docs/architecture.md](docs/architecture.md) for implementation details.
