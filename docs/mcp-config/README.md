# Host Tool MCP 接入配置文档

> host-tool-mcp-server 是一个**纯中介进程**：对后端是标准 MCP（streamable-http），对前端是自定义 WS，
> 靠业务 `session_id` 把两边按会话拼接起来。本文档说明三方各自的配置与接入步骤。

## 角色

| 角色 | 进程 | 监听面 | 职责 |
| --- | --- | --- | --- |
| **MCP Server** | `host-tool-mcp-server`（`:8787`） | `/mcp`（streamable-http，对后端）<br>`/ws`（自定义 WS，对前端） | 路由中介：按 `_meta.session_id` 把 `tools/call` 路由到对应前端 WS |
| **后端** | agent 平台 | 业务 API | 标准 MCP client；调用时把 session_id 塞进 `_meta.session_id` |
| **前端** | 浏览器执行端 | — | WS client；register 登记；收到 invoke → 执行 → 回 result |

```
后端 ──标准 MCP(streamable-http)──> /mcp
                                       │ 按 session_id 路由
前端 ──自定义 WS──────────────────> /ws
```

## 相关代码位置

本文档只保留接入配置说明，代码与产物均在仓库主线工程中维护：

```
仓库根目录/
├── host-tool-mcp-server/                    ← MCP server 工程（npm workspace，可独立 build & start）
│   ├── WORKFLOW.md                          ← 原始工作流时序图
│   ├── package.json / tsconfig.json
│   ├── config/
│   │   └── tools.yaml                       ← 工具清单（决定 tools/list 返回什么）
│   └── src/                                 ← main / mcp-face / ws-face / router / config
└── packages/agent-widget/dist/
    └── ragsystem-mcp-client.umd.cjs         ← 前端 WS 客户端构建产物（全局 `RagMcpClient`）
```

> server 是自包含的 TS 工程（根 npm workspace 成员），`cd host-tool-mcp-server && npm install && npm run build` 即可跑起。
> 前端客户端通过构建 agent-widget 产出，不要手工复制旧产物。运行所需依赖清单与启动步骤见下文「一、MCP Server 配置」。

---

## 一、MCP Server 配置

### 1.1 启动

```bash
cd host-tool-mcp-server      # 仓库根目录下的 server 工程
npm install                  # 安装依赖（首次）
npm run build                # 编译 TS → dist/
npm start                    # 默认 127.0.0.1:8787
```

> 工程依赖 `@ragsystem/agent-protocol` 包（见 `package.json`）。在本仓库 monorepo 内直接 `npm install`；
> 如果要脱离 monorepo 独立部署，需先确认此包可解析（workspace 链接 / 发布源）。

### 1.2 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8787` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址 |
| `TOOLS_CONFIG` | `host-tool-mcp-server/config/tools.yaml` | 工具清单路径，可覆盖（绝对路径或相对运行目录） |

### 1.3 修改工具清单

**只改 `host-tool-mcp-server/config/tools.yaml`，改完重启 server。** server 源码不用动。

每个工具的声明字段：

```yaml
tools:
  - name: click                    # 工具名，三方对齐的 key
    description: "点击匹配 selector 的元素。"
    input_schema:                  # JSON Schema，LLM 看到的参数定义
      type: object
      properties:
        selector: { type: string, description: "CSS 选择器" }
      required: [selector]
      additionalProperties: false
    risk_level: medium             # 可选：low / medium / high
```

⚠️ 注意：`tools/list` 返回的是这份 yaml，但**调用能否路由成功取决于前端有没有 register 同名工具**（server 内部 `state.tools.has(toolName)` 判定，来自前端 register）。
所以加/改一个工具 = **yaml + 前端 register + 前端 execute 实现** 三处同步，详见后端/前端章节。

---

## 二、后端配置

把 MCP server 当一个**标准的 streamable-http MCP server** 接入即可，不需要知道前端存在。

### 2.1 接入 MCP server

- **endpoint**：`http://<host>:8787/mcp`
- **协议**：streamable-http（stateful）。
  - 启动时发 `initialize`，响应头里拿到 `Mcp-Session-Id`；
  - 之后所有请求（`tools/list`、`tools/call`）都带这个 header 复用 transport。
- 任意 MCP client SDK 都能直接连。

### 2.2 拉工具清单并注册给 agent

- 调一次 `tools/list`，拿到静态清单（即 `host-tool-mcp-server/config/tools.yaml` 的内容）。
- 把每个 tool 包成 agent 可调用的工具，建议加前缀 `mcp__frontend-tools__<name>` 避免和本地工具撞名。
- 这份清单是**静态**的，拉一次缓存即可，不随前端连不连变化。

### 2.3 调用时带 session_id（关键）

agent 决定调某工具时，发 `tools/call`：

```jsonc
{
  "method": "tools/call",
  "params": {
    "name": "click",
    "arguments": { "selector": "#submit-btn" },
    "_meta": { "session_id": "<当前对话的 session_id>" }
  }
}
```

**session_id 必须放 `params._meta.session_id`**：

- ❌ 不要塞进 `arguments`（那是给模型看的工具参数）
- ❌ 不要放进 transport header（`Mcp-Session-Id` 只管连接复用，是另一码事）
- ✅ 只能走 `_meta`（MCP 协议留给运行时元数据的字段）

### 2.4 处理结果

返回标准 MCP `CallToolResult`：

| 字段 | 说明 |
| --- | --- |
| `content[0].text` | observation 文本 |
| `isError` | 成败标记 |

**软失败**（缺 session_id / 该 session 无执行端 / schema 不匹配 / 60s 超时）也走正常 result，
observation 里是提示文本，**不抛异常**——按普通 tool result 回填给 LLM 即可，不用特殊兜底。

---

## 三、前端配置

前端是**执行端**：连一条 WS，登记能跑哪些工具，收到调用执行后回传结果。

已有现成客户端（构建产物 `packages/agent-widget/dist/ragsystem-mcp-client.umd.cjs`，全局 `RagMcpClient`），WS 协议、重连、invoke 分派、result 回传全包了。
前端只需准备三样：**构造参数、工具实现、生命周期调用**。

### 3.1 引入客户端

```html
<script src="./ragsystem-mcp-client.umd.cjs"></script>
<!-- 从 packages/agent-widget/dist/ 复制构建产物到页面可访问目录；暴露全局 window.RagMcpClient -->
```

### 3.2 构造：`{ url, sessionId }`

```js
const client = new RagMcpClient({
  url: "ws://127.0.0.1:8787/ws",
  sessionId: "<当前会话的 session_id>",
});
```

- `url` 固定指向 MCP server 的 `/ws`。
- `sessionId` 必须和后端 `_meta.session_id` 用**同一个串**——这是唯一需要从后端同步过来的东西。

### 3.3 注册工具：`{ name, description, inputSchema, riskLevel?, execute }`

```js
client.registerTool({
  name: "click",                    // 必须和 host-tool-mcp-server/config/tools.yaml 的 name 一致
  description: "点击匹配 selector 的元素。",
  inputSchema: {                    // 必须和 tools.yaml 的 input_schema 一致（见 host-tool-mcp-server/config/）
    type: "object",
    properties: { selector: { type: "string", description: "CSS 选择器" } },
    required: ["selector"],
    additionalProperties: false,
  },
  riskLevel: "medium",              // 可选
  async execute(input) {            // 收到 invoke 时执行，input 即 arguments
    document.querySelector(input.selector)?.click();
    return { ok: true, observation: "已点击" };
  },
});

client.connect();
```

`execute(input)` 返回契约：

| 字段 | 必需 | 说明 |
| --- | --- | --- |
| `observation` | 是 | string，回传给 LLM 的结果文本 |
| `ok` | 否 | 默认 `true`；失败传 `false` |
| `error` | 否 | 失败原因 |

`execute` 抛异常会被自动兜成 `ok:false`，observation 用错误消息——正常 throw 即可，不用全 try/catch。

### 3.4 生命周期

- **拿到 session_id 后**：`registerTool(s)` → `connect()`。连上 `onopen` 会自动把已注册工具发 register。
- **换会话时**：`disconnect()` 再用新 sessionId 重建。`disconnect` 清掉重连计数、阻止自动重连。
- 工具注册顺序无所谓：`registerTool` 内部每次都全量重发 register，连上后注册也会补发。

### 3.5 对齐校验

| 前端 | yaml | 不一致的后果 |
| --- | --- | --- |
| `name` | `name` | 调用时 `state.tools.has` 命中失败 → 软失败 |
| `inputSchema` | `input_schema` | server 只 warn 不阻断，但 LLM 看到的 schema 和实际执行对不上会出错 |

**前端工具的 name + inputSchema 必须照抄 `host-tool-mcp-server/config/tools.yaml`**。`execute` 实现是 yaml 里没有、只能前端写的部分。

---

## 四、贯穿前后的 session_id

接入唯一容易踩坑的点。

- **同一个 session_id 要同时出现在两个地方**：
  - 后端调用放进 `_meta.session_id`；
  - 前端 register 上报 `session_id`。
- 两条线在 server 端汇合：register 建立 `session_id → 前端 ws` 映射，call 时查这张表路由。
- 来源通常是**后端建会话时生成**，再通过任意业务通道（API 响应、回调、WS 消息……）告诉前端。只要两边拿到的是同一个串就行，怎么传自己定。
- session_id 是**业务会话 ID**，和 MCP transport 的 `Mcp-Session-Id`（连接复用 ID）是两码事，别混。

---

## 五、工具端到端变更 Checklist

加 / 改一个工具，三处同步：

- [ ] `host-tool-mcp-server/config/tools.yaml`（改完**重启 server**）
- [ ] 前端 register 的 `name` + `inputSchema` 对齐
- [ ] 前端 `execute` 实现干活逻辑

只改 `execute` 实现（不动 name/schema）：yaml 和 register 都不用动。
server 源码始终不用动。

---

## 六、完整调用闭环（摘自 `host-tool-mcp-server/WORKFLOW.md`）

以「用户说：点击页面按钮」为例，agent 决定调用 `mcp__frontend-tools__click`：

```
用户 → 前端 Widget
前端 → 后端：POST 启动 run
后端 → LLM：组 prompt + tools(含 mcp__frontend-tools__click)
LLM → 后端：返回 tool_call
后端 → MCP server：tools/call 携带 arguments 与 _meta.session_id
MCP server：从 _meta.session_id 取 session → 查路由表 → 挂 pending
MCP server → 前端：WS invoke 下发 call_id + tool + input
前端：execute(input) 操作 DOM
前端 → MCP server：WS result 回传 call_id + observation
MCP server：resolve pending
MCP server → 后端：MCP result（content 文本 = observation）
后端 → LLM：observation 回填，继续 ReAct / 出最终答案
后端 → 前端：WS Envelope（tool_call / tool_result / 最终答案）
```

详见 `host-tool-mcp-server/WORKFLOW.md`（含启动握手、会话切换、session_id 全链路数据流）。

---

## 附录：结果回传契约（参考）

以下接口摘自前端 adapter 实现，供对照查阅。

```ts
/**
 * 宿主工具 execute() 的返回值（前端代码层）。
 */
interface ToolResult {
  /** 成功/失败标志（必填） */
  ok: boolean;
  /** 喂给 LLM 的观察内容，作为 tool_result 主体（必填） */
  observation: string;
  /** 失败原因（可选） */
  error?: string;
  /** 执行耗时（可选） */
  elapsedMs?: number;
}

/**
 * delegate_result （协议层，前端 → 后端）。
 */
interface DelegateResultUplink {
  /** 帧类型固定字面量 */
  type: "delegate_result";
  /** 会话 ID */
  session_id: string;
  /** 关联原始 delegate_call 的调用 ID */
  call_id: string;
  payload: {
    /** 阶段固定字面量 */
    phase: "result";
    /** 成功/失败标志（必填） */
    ok: boolean;
    /** 观察内容，仅 ToolResult.observation !== undefined 时携带（可选） */
    observation?: string;
    /** 失败原因，ok:false 时携带（可选） */
    error?: string;
    /** 执行耗时；工具未给则 adapter 用 Date.now() - started 兜底（可选） */
    elapsed_ms?: number;
  };
}
```

**字段映射关系**（`ToolResult` → `delegate_result.payload`）：

| ToolResult（工具层） | delegate_result.payload（协议层） | 说明                                  |
| -------------------- | --------------------------------- | ------------------------------------- |
| `ok`                 | `ok`                              | 直传                                  |
| `observation`        | `observation`                     | 直传，仅 `!== undefined` 时带         |
| `error`              | `error`                           | 直传，仅 `!== undefined` 时带         |
| `elapsedMs`          | `elapsed_ms`                      | 驼峰转下划线；未给时 adapter 自动兜底 |
| —                    | `phase: "result"`                 | adapter 固定补                        |
