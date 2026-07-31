# 共享协议包

`packages/` 下有六个 workspace 包。本章区分“共享包总量”和“各应用的直接依赖”，所有清单来自各包的 `package.json`。

## 总览

| 包 | 包名 | 职责 | 被谁用 |
|----|------|------|--------|
| `agent-protocol` | `@ragsystem/agent-protocol` | 前后端共享事件/类型契约 | backend-ts + frontend-client |
| `agent-sdk` | `@ragsystem/agent-sdk` | Agent 运行时内核 SDK | backend-ts |
| `agent-llm` | `@ragsystem/agent-llm` | LLM Provider 适配 | backend-ts |
| `agent-widget` | `@ragsystem/agent-widget` | 第三方嵌入 Widget | 前端（iframe/Web Component） |
| `chat-sdk-core` | `@ragsystem/chat-sdk-core` | 无 UI 的 REST + WebSocket Chat SDK 门面 | agent-widget + 外部宿主 |
| `api-contracts` | `@ragsystem/api-contracts` | REST/session 请求响应 Zod 契约 | backend-ts + frontend-client |

## agent-protocol（前后端共享契约）

**最关键的耦合点**。前后端共用此包，保证事件结构、会话协议、执行树定义一致。

`package.json`：

```json
{
  "name": "@ragsystem/agent-protocol",
  "main": "./dist/index.js",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "dependencies": { "zod": "^3.23.0" }
}
```

`src/index.ts` 导出 4 个模块：

| 模块 | 内容 |
|------|------|
| `protocol.ts` | 核心协议类型定义 |
| `agent-client.ts` | Agent 客户端 |
| `envelope-delivery.ts` | Envelope 投递与游标处理 |
| `execution-tree.ts` | 执行树结构 |

::: tip 构建要求
包以 `dist/` 为产物（`files: ["dist"]`），使用前需 `npm -w @ragsystem/agent-protocol run build`（根 `package.json` 有 `build:protocol` 脚本）。`sideEffects: false` 便于 tree-shaking。
:::

::: warning 变更影响面
此包任何 wire/event 类型变更会影响 backend、frontend、api-contracts、chat-sdk-core、agent-widget 和 host-tool-mcp-server 的消费者。修改后需运行 protocol 的 typecheck/test，并重建受影响 workspace。
:::

## agent-sdk（运行时内核 SDK）

Agent 运行时的内核实现，被 `backend-ts` 的 `services/agent/sdk/` 层适配。

`src/` 结构：

| 模块 | 职责 |
|------|------|
| `kernel.ts` / `kernel-context.ts` | 内核与上下文 |
| `runtime.ts` | 运行时 |
| `kernel-events.ts` | 完整 `KernelEvent` 运行时事件契约 |
| `abort.ts` / `recoverable-interrupt.ts` | 取消与可恢复挂起语义 |
| `dispatcher.ts` | 分发器 |
| `async-queue.ts` | 异步队列 |
| `llm-client.ts` | LLM 客户端抽象 |
| `llm-protocol/` | LLM 协议 |
| `llm-params/` | LLM 参数 |
| `prompt/` | prompt 处理 |
| `tools/` | 工具运行时 |
| `hooks/` | 钩子系统（`HookRegistry`） |
| `compression/` | 上下文压缩 |
| `contracts.ts` / `types.ts` | 契约与类型 |

`backend-ts` 通过 `services/agent/sdk/runtime-adapter.ts` 等文件将 SDK 内核适配到 Fastify 运行时，并注册 hook（`runtime-container.ts` 的 `hooks` 选项透传 `HookRegistry`）。`event-translation.ts` 在该适配层把 SDK `KernelEvent` 投影成 protocol `Envelope`。

## agent-llm（LLM Provider 适配）

封装不同 LLM Provider 的协议差异。

`src/` 结构：

| 模块 | 职责 |
|------|------|
| `provider-registry.ts` | Provider 注册表 |
| `openai-compatible-client.ts` | OpenAI 兼容客户端 |
| `content-parts.ts` | 内容块处理 |
| `record-utils.ts` | 记录工具 |
| `types.ts` | 类型定义 |

`backend-ts` 的 `ModelAdapterService` 负责配置管理，实际的 LLM 调用委托给此包。`provider-registry` 支持多 provider（OpenAI / Anthropic 等），`backend-ts/package.json` 同时依赖 `@modelcontextprotocol/sdk` 与此包。

## agent-widget（第三方嵌入 Widget）

把聊天能力以可嵌入第三方站点的形式提供。

`src/` 结构：

| 模块 | 职责 |
|------|------|
| `web-component/` | Web Component 封装 |
| `iframe-bridge/` | iframe 通信桥 |
| `adapter/` | 适配层 |
| `components/` | UI 组件 |
| `icons/` | 图标 |
| `styles/` | 样式 |
| `utils/` | 工具 |

::: tip widget 鉴权
`backend-ts` 通过 `WIDGET_JWT_KEY_RING` 环境变量启用 widget 第三方嵌入鉴权（`jwt-service.ts`）。未配置时 widget 鉴权不启用。详见 [配置](/03-guides/configuration)。
:::

## 依赖拓扑与构建顺序

依赖不是线性序列，而是 DAG：

```
agent-llm ----> agent-sdk -----------------> backend-ts
agent-protocol ----> api-contracts --------> backend-ts
       |                  |                  |
       |                  +---------------> chat-sdk-core ----> agent-widget
       +----------------------------------> frontend-client
```

实际可执行顺序：

1. 并行构建 `agent-llm` 与 `agent-protocol`。
2. 构建 `api-contracts`、`agent-sdk`。
3. 构建 `chat-sdk-core`，再构建 `agent-widget`。
4. 构建 `backend-ts` 和 `frontend-client`。

`host-tool-mcp-server` 直接依赖 `agent-protocol`，不属于 `packages/` 六包，但也是 workspace 消费者。

根 `package.json` 提供：

```json
"build:protocol": "npm -w @ragsystem/agent-protocol run build",
"build:chat-sdk": "npm run build:contracts && npm -w @ragsystem/chat-sdk-core run build",
"typecheck:protocol": "npm -w @ragsystem/agent-protocol run typecheck",
"typecheck:backend": "npm -w @ragsystem/backend-ts run typecheck"
```

::: tip 开发时
workspace 机制让本地包以符号链接形式互相引用，改 protocol 源码后需重建 protocol 才能让 backend/frontend 看到新类型。
:::
