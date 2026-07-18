# TS 后端分层

::: tip 鉴权封装域
`buildApp()` 按身份与 Runtime 需求注册 Fastify 子域：普通租户业务使用 tenant session identity + Tenant Runtime，平台路由显式请求 platform identity，Widget 业务使用 widget identity + Tenant Runtime。公开 webhook/token 必须通过 `config.auth = "public"` 显式声明；Session WebSocket 独立消费单次 ticket。Identity Provider 不再检查 URL 来推断平台路由。
:::

本章拆解 `backend-ts` 的内部分层与请求流转。所有结论基于 `backend-ts/src/` 的实际目录结构与 `app.ts` / `runtime-container.ts` 的装配逻辑。

## 目录结构

```
backend-ts/src/
├── main.ts                  # 入口：loadEnv → buildApp → listen → 信号优雅关闭
├── app.ts                   # 应用装配：插件注册 + 路由前缀 + 错误处理 + 前端 fallback
├── config/
│   └── env.ts               # 环境变量解析（zod schema + .env 手动读取）
├── cli/
│   └── widget-app.ts        # widget CLI
├── contracts/               # 共享契约层（接口抽象，按存储域分包）
│   ├── conversation-store/
│   ├── control-plane/      # 异步 tenant/user/membership/settings/session/audit ports
│   ├── file-history-store/
│   ├── file-index-store/
│   ├── memory-store/
│   ├── vector-store/        # 含 driver-registry / embedder / knowledge-config
│   ├── events.ts
│   ├── execution.ts
│   ├── session.ts
│   ├── mcp.ts
│   ├── permissions.ts
│   ├── runtime-core.ts
│   ├── widget.ts
│   ├── model-adapter.ts
│   ├── knowledge-base.ts
│   └── ...（共 20+ 契约文件）
├── routes/                  # Fastify 路由模块
│   ├── agent/               # agent 域子路由（9 个文件）
│   ├── mcp.ts
│   ├── model-adapter.ts
│   ├── knowledge-base.ts
│   ├── ...（顶层 14 个路由模块）
│   └── route-options.ts
├── services/                # 核心业务服务层
│   ├── runtime/             # DI 容器 + 事件 outbox + 后台任务
│   ├── agent/               # agent 执行/委派/上下文/记忆/prompt
│   ├── agui-gateway/        # AG-UI 翻译/SSE/interrupt
│   ├── integrations/        # MCP / 模型适配 / embedder
│   ├── knowledge/           # 知识库 / embedding 模型
│   ├── stores/              # conversation / file-history / memory / widget-credential
│   ├── vector-store/        # sqlite-vec driver / registry / scoring / factory
│   ├── config/              # 系统配置
│   ├── daemon/              # 守护进程
│   ├── sessions/            # 会话应用
│   ├── skills/              # 技能库
│   └── artifacts/           # 产物
├── tools/                   # 内置工具实现（每个工具一个目录）
│   ├── BashTool/
│   ├── CodeExecutionTool/
│   ├── DelegationTools/
│   ├── DocumentTools/
│   ├── KnowledgeTools/
│   ├── LocalSearchTools/
│   ├── McpTools/
│   ├── MemoryTools/
│   ├── RequestUserInputTool/
│   ├── SkillTools/
│   ├── TaskTools/
│   ├── registry.ts          # 工具注册表
│   └── schema-helpers.ts
└── utils/
    ├── errors.ts
    ├── file-filter.ts
    ├── guards.ts
    └── yaml-io.ts
```

## 分层职责

### 1. 入口层（`main.ts` + `app.ts`）

- `main.ts`：加载环境 → 构建应用 → 监听 → 注册 `SIGINT`/`SIGTERM` 优雅关闭
- `app.ts`：注册 Fastify 插件（cors / multipart / websocket）、全局错误处理器、所有路由前缀、前端静态资源 fallback

### 2. 契约层（`contracts/`）

**接口抽象层，按存储域分包**。这是后端的"脊柱"，定义了所有存储与协议的接口契约：

- 存储契约：`conversation-store` / `file-history-store` / `file-index-store` / `memory-store` / `vector-store`
- 协议契约：`events` / `execution` / `session` / `mcp` / `permissions` / `runtime-core` / `widget`

每个 store 契约定义了对应的 `I*Store` 接口，实现可替换（如 `vector-store` 支持 driver-registry 多驱动）。

### 3. 路由层（`routes/`）

Fastify 路由模块，每个 `register*Routes` 函数接收 `{ container }` 注入运行时容器。路由层**只做参数校验与调用转发**，业务逻辑全在 service 层。

路由前缀在 `app.ts` 中集中注册，详见 [HTTP 路由清单](/04-api/http)。

### 4. 服务层（`services/`）

核心业务逻辑。由 `runtime-container.ts` 统一装配为 DI 容器：

- `runtime/` — DI 容器、`RealtimeEventHub`、`BackgroundTaskService`、`PermissionPolicyService`、`HostToolRegistry`、event-outbox（dispatcher + projector + durable publisher）、`jwt-service`（widget 鉴权）、`runtime-tool-bridge`
- `agent/` — `execution/`（run-engine + runtime-core-service + launchers + slash-command-handler + status-tracker + readiness）、`delegation/`、`context/` + `context-compression/`、`memory/`、`metrics/`、`prompt-builder/`、`sdk/`（runtime-adapter + event-persister + gate-hook + projection）、`config/`（team-store + yaml）
- `integrations/` — `mcp-service`、`model-adapter-service`、`embedder-registry`、`embedding-client`、`provider-registry`
- `knowledge/` — `knowledge-base-service`、`embedding-model-service`、document extraction
- `stores/` — 各 store 的具体实现
- `vector-store/` — `sqlite-vec-driver`、`registry`、`scoring`、`factory`
- `agui-gateway/` — AG-UI 翻译/SSE/interrupt 状态机

### 5. 工具层（`tools/`）

每个内置工具一个目录，含 Tool 定义 + Execution 服务。通过 `registry.ts` 注册，运行时由 `runtime-tool-bridge` 装配为 per-agent 工具集。详见 [工具系统](./tool-system)。

## 请求流转

以一次 MCP 工具调用为例：

```
HTTP 请求
  │  app.ts 注册的路由前缀（/api/mcp）
  ▼
routes/mcp.ts                    # 路由层：参数校验（zod schema）
  │  options.container.mcp       # 从 DI 容器取 service
  ▼
services/integrations/mcp-service.ts   # 业务层：McpService.callTool()
  │
  ▼
@modelcontextprotocol/sdk        # MCP 协议层
  │
  ▼
外部 MCP 服务器
```

## 错误处理

`app.ts` 的全局错误处理器（`app.ts:52-96`）分层处理：

1. `HttpError` → 按其 `statusCode` 返回
2. Fastify 校验错误（`validation`）→ 400
3. `ZodError` → 400，details 为字段级错误
4. 其他 4xx（含 `FST_ERR_CTP_INVALID_MEDIA_TYPE` → 415）→ 对应状态码
5. 兜底 → 500，日志记录

## DI 容器

`createRuntimeContainer`（`runtime-container.ts:112`）是唯一的装配点：

- 接收 `{ dbPath, dataRoot, ... }`
- 实例化全部 service 并互相注入
- 返回 `RuntimeContainer`（含 30+ readonly 字段）
- 注册 `onClose` hook 在应用关闭时逆序释放资源

这是理解整个后端依赖关系的入口文件。详见 [Agent 运行时](./agent-runtime)。
