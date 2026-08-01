# @ragsystem/chat-sdk-core

RAGSystem 的无界面 Chat SDK。它把认证后的 REST 资源管理和长期 WebSocket 会话统一到一个 client 门面中，不提供 Vue、消息列表或任何 UI。

```ts
import { createRagChatClient, loginRagSystem } from "@ragsystem/chat-sdk-core";

const auth = await loginRagSystem({
  baseUrl: "https://rag.example.com",
  username: "demo",
  password: "secret",
});

const client = createRagChatClient({
  baseUrl: "https://rag.example.com",
  token: auth.token,
});

const session = await client.createSession();
client.on("stream_output", (event) => console.log(event));
client.on("runtime", (runtime) => console.log(runtime));

await client.connect(session.data.session_id);
await client.send({ task: "总结当前会话" });
```

`send()` 的返回值表示后端是否接受了运行请求；运行期间的文本、工具调用、交互和终态通过 `on()` 事件和 `runtime`/`execution_tree` 事件提供。WebSocket 断线会使用 durable cursor 自动重连和补放。

连接策略固定为 WebSocket 主通道、AG-UI/SSE fallback：`aguiFallback` 默认开启，只有 Session WebSocket 尚未就绪时，`send()` 才会 POST 到 `/api/agui` 并消费 AG-UI SSE；恢复连接后新的发送继续走 WebSocket。需要完全关闭 fallback 时设置 `aguiFallback: false`。也可以直接使用 `startAguiRun()` 消费 AG-UI run，不需要另行接入旧的 HTTP stream 接口。

交互可以交给宿主 UI 手动处理，也可以在创建 client 时自动处理：

```ts
const client = createRagChatClient({
  token: auth.token,
  interactionHandlers: {
    approval: async () => ({ kind: "approval", approved: true }),
  },
});
```

没有注册 handler 时，SDK 只发布 `interaction_request`，不会替宿主做决定。

认证支持静态 `token`、动态 `getToken`、静态/动态 headers，以及自定义 `fetch` 和 WebSocket 工厂。`loginRagSystem()` 只负责调用 `/api/auth/login` 获取 session token，登录页面和 token 持久化由宿主应用负责。

文件下载使用 `downloadFile(sessionId, fileId)`，返回原始 `Response` 以便宿主按需读取 `blob()`、流和响应头。`fetchAsset()` 仅对与 `baseUrl` 同源的资源自动附加 Bearer token，跨域资源默认不携带 RAGSystem 凭据。

会话 REST 也通过同一个 client 提供，包括列表、详情、消息、执行步骤、权限、文件、导出、context snapshot 和 rollback/retry；宿主不需要再维护第二套认证 HTTP client。

主要事件包括：`event`、协议原始事件类型（如 `stream_output`、`session.runtime`）、`status`、`runtime`、`execution_tree`、`run_status`、`pending_interactions`、`unauthorized` 和 `error`。
