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

主要事件包括：`event`、协议原始事件类型（如 `stream_output`、`session.runtime`）、`status`、`runtime`、`execution_tree`、`run_status`、`pending_interactions`、`unauthorized` 和 `error`。
