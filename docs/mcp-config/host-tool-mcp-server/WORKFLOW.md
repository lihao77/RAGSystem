# 前端 / MCP / 后端 完整工作流时序图

> 本文档说明 **host-tool-mcp-server**(前端工具 MCP 桥接中介)在「前端 widget — MCP server — 后端 agent」三方之间的完整工作流。
> 核心问题:**一次 MCP 工具调用,session id 是怎么从后端会话一路带到前端执行端的。**

## 参与者与端口

| 角色 | 产物 / 进程 | 监听面 | 职责 |
| --- | --- | --- | --- |
| **前端 · Widget** | `ragsystem-widget.umd.cjs`(全局 `RagWidget`) | — | 消息入口;懒建 session;`onSessionChange` 把 session_id 回调给页面 |
| **前端 · RagMcpClient** | `ragsystem-mcp-client.umd.cjs`(全局 `RagMcpClient`) | WS client → `/ws` | 执行端;上报工具 register;收 invoke → 执行 → 回 result |
| **前端 · HostTools** | `ragsystem-host-tools.umd.cjs`(全局 `RagHostTools`) | — | DOM / map 工具实现(`execute(input)` 操作宿主页面) |
| **MCP Server** | `host-tool-mcp-server` 独立进程(`:8787`) | `/mcp`(streamable-http,对后端)<br>`/ws`(自定义 WS,对前端) | 路由中介:把 backend 的 `tools/call` 按 `_meta.session_id` 路由到对应前端 WS |
| **后端 · Backend** | `backend-ts`(`:5002`) | REST `/api/agent/stream`<br>WS `/api/agent/ws` | agent 运行 + 标准 MCP client(`McpService`);`McpTools` 把 ctx.sessionId 包成 `_meta` |

> 三方解耦:后端只认**标准 MCP**(把 server 当一个 streamable_http MCP server 接入);server 是纯路由中介;前端只认**自定义 WS** 协议。两两之间无直接耦合。

---

## 时序图 A:启动握手 + 执行端注册

```mermaid
sequenceDiagram
    autonumber
    participant B as 后端 McpService
    participant S as MCP Server (8787)
    participant W as 前端 Widget
    participant C as 前端 RagMcpClient

    rect rgb(230, 245, 255)
    Note over B,S: ① Backend 与 MCP server 握手 (streamable-http, 启动时/lazy)
    B->>S: POST /mcp initialize (新建 transport, 生成 Mcp-Session-Id)
    B->>S: tools/list
    S-->>B: 返回静态清单 (config/tools.yaml)
    Note over B: createMcpTools — 每个 tool 包 buildTool 壳<br/>命名 mcp__frontend-tools__*
    end

    rect rgb(240, 255, 240)
    Note over W,S: ② 前端懒建 session + 注册执行端 (WS)
    W->>W: 用户发首条消息 → 触发建会话
    Note over W: Widget 拿到 session_id
    W->>C: onSessionChange(session_id)<br/>new RagMcpClient + registerTools
    C->>S: WS connect ws://127.0.0.1:8787/ws
    C->>S: WS register 上报 session_id 与 tools 清单
    Note over S: ws-face.handleWsMessage → router.register
    Note over S: 绑定 sessions 映射 — session_id 指向 ws 与 tools<br/>schema 与静态清单比对, 不一致仅 warn
    end
```

**要点**

- `tools/list` 永远返回 `config/tools.yaml` **静态清单**,不查路由、不随前端连接变化 —— 后端拉一次即可,即便前端此刻没连上,`list` 也正常(只是后续 `call` 会软失败)。
- 注册时机由 **Widget 的 `onSessionChange` 回调**驱动:session_id 就绪 → 建执行端 → register。
- `Mcp-Session-Id`(HTTP header)= transport 会话复用 ID,**不是**业务 session_id;业务 session_id 走 WS register 上报。

---

## 时序图 B:一次工具调用闭环(核心)

以「用户对 widget 说:点击页面按钮」为例,agent 决定调用 `mcp__frontend-tools__click`。

```mermaid
sequenceDiagram
    autonumber
    participant U as 用户
    participant W as 前端 Widget
    participant B as 后端 Agent + McpService
    participant L as LLM
    participant S as MCP Server (Router)
    participant C as 前端 RagMcpClient
    participant H as 前端 HostTools

    U->>W: 发消息「点击页面按钮」
    W->>B: POST /api/agent/stream (启动 run)
    Note over B: run 启动<br/>ToolExecContext.sessionId = 会话 ID
    B->>L: 组 prompt + tools(含 mcp__frontend-tools__click)
    L-->>B: 返回 tool_call — mcp__frontend-tools__click

    Note over B: tool-round-executor 调 McpTools 壳 call(input, ctx)
    B->>B: callRuntimeTool 封装 session_id 来自 ctx.sessionId
    B->>S: tools/call 携带 arguments 与 _meta.session_id<br/>POST /mcp, 携带 Mcp-Session-Id header

    Note over S: mcp-face 从 params._meta.session_id 取出会话
    S->>S: router.invoke(sessionId, toolName, args)
    Note over S: 查 sessions 映射 sessionId → ws, 挂 pending 记 call_id
    S->>C: WS invoke 下发 call_id 与 tool、input

    C->>H: decl.execute(input) — 操作宿主页面 DOM
    H-->>C: ToolResult observation

    C->>S: WS result 回传 call_id、ok、observation、elapsed_ms
    Note over S: ws-face → router.deliverResult → resolve pending
    S-->>B: MCP result — content 文本为 observation, isError 取反 ok

    Note over B: normalizeToolResult → ToolExecutionResult
    B->>L: observation 回填 → 继续 ReAct / 出最终答案
    B-->>W: WS Envelope — tool_call / tool_result / 最终答案
    W-->>U: 渲染执行节点 + 文字回答
```

**要点**

- session_id 不进工具 `arguments`(对模型不可见),只走 MCP 规范的 **`_meta`** 字段 —— 这是协议层给「额外元数据」留的口子。
- 后端 → server 是**标准 MCP**(`tools/call`);server → 前端是**自定义 WS**(`invoke`/`result`);server 内部用 `Router` 把两者按 session_id 拼接。
- 缺 session_id / 该 session 无执行端 / schema 不匹配 / 执行超时(60s)→ 均返回**软失败** `ToolResult`(observation 文本),对标 delegate 失败分支,不抛异常打断 run。

---

## 时序图 C:会话切换(newSession)

```mermaid
sequenceDiagram
    autonumber
    participant W as 前端 Widget
    participant C as 前端 RagMcpClient
    participant S as MCP Server (Router)

    Note over W: 用户开新对话 → Widget newSession
    W->>C: onSessionChange(null)
    C->>S: WS close (主动断开)
    Note over S: router.disconnect(ws)<br/>清理该 ws 关联的全部 session
    Note over W: 下次发消息 → 建新会话<br/>回调再触发 register(回到时序图 A ②)
```

**要点**:会话与执行端**一一绑定**,切换会话即断开旧执行端、按新 session_id 重新注册,杜绝跨会话串扰。

---

## 附图:session_id 全链路数据流

```mermaid
flowchart LR
    R["run 启动<br/>SdkExecuteRunInput.sessionId<br/>runtime-adapter.ts:144"]
    Ctx["ToolExecContext.sessionId<br/>SDK ctx 透传到每次 call"]
    Shell["McpTools 壳 call(ctx)<br/>{ session_id: ctx.sessionId }<br/>McpTools.ts:32"]
    Meta["_meta.session_id<br/>McpService → MCP 协议<br/>mcp-service.ts:657"]
    Router["router.invoke(sessionId)<br/>mcp-face.ts:30"]
    Reg["sessions[sessionId] = ws<br/>register 阶段绑定<br/>router.ts:48"]
    Ws["WS invoke → 前端 HostTools.execute"]

    R --> Ctx --> Shell --> Meta --> Router
    Reg -. 路由查表 .-> Router
    Router --> Ws
```

两条线在 server 端汇合:**注册阶段**建立的 `session_id → 前端 ws` 映射,供**调用阶段**的 `router.invoke` 查表路由。

---

## 关键设计点

1. **session_id 走 `_meta`,不走 arguments / 不走 transport header**
   `arguments` 是给模型看的工具参数,session_id 属运行时元数据,放 `_meta` 既不污染模型输入、又符合 MCP 规范。transport 层的 `Mcp-Session-Id` header 只管连接复用,两者互不干扰。

2. **中介进程承担「协议转换 + 会话路由」**
   后端 ↔ server 是标准 MCP(streamable-http);server ↔ 前端是自定义 WS。server 内部 `Router` 用 `session_id` 作 key,把标准 `tools/call` 路由到正确的浏览器执行端,支持多前端 / 多会话并发隔离。

3. **配置驱动 + 自描述下沉**
   `tools/list` 返回 `config/tools.yaml` 静态清单(后端拉一次);前端 register 时上报运行时声明,server 仅做 schema 漂移告警(不阻断)。工具的「能力声明」与「执行实现」分离:声明静态、执行动态。

4. **与 delegate 路径并存(`mcp__` 前缀隔离)**
   host-tool-mcp-bridge 是「第二条调用路径」,与既有委托模式(delegate_call / delegate_result)并存,通过 `mcp__` 工具名前缀天然隔离,互不影响。
