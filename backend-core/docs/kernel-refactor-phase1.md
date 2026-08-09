# Agent 微内核重构 — 阶段一（内核 + Protocol/Tool + EventSink 导线）

> 状态：已逐文件核对现有代码，多轮对齐后定稿。本文为最终实施方案。
> 铁律：**阶段一是结构搬家，行为零变化**。验收 = 现状两条路径（XML 流式工具循环、纯流式）行为完全等价 + typecheck/build 通过。

## 一、要治的三个病

`backend-ts/src/services/agent/agent-runtime-core.ts` 一个类干了所有事：

1. **多循环重复**：`runText` 四路分发——`runXmlToolCallingText`(L257)、`runToolCallingText`(L370)、`runStreamingText`(L577)、`completeRequest`(非流式补全)——轮次推进、abort 检查、消息 append、observation 回填、事件发射各写一遍。其中 `runToolCallingText`(原生 FC)与 `completeRequest`(非流式)由**同一 `!stream` 条件**把守，生产环境 `llmChatClient.stream` 恒存在，二者皆为死代码。
2. **内核硬编码协议**：XML 解析、协议修复重试、消息语义包装全内联，协议不可替换。
3. **两个调用方重复**：`run-engine.executeRun` 与 `agent-delegation.executeChildRun` 各自重复 `refreshStablePrefixCache`，各自注入 `onEvent`/`conversationUpdateProvider`/`onModelRequestSuccess` 三回调。

核心矛盾：**不变的循环骨架与可替换的具体能力焊死在一起**。

## 二、架构：内核是轴，三只手 + 一根导线

```
                AgentKernel (kernel/，只 import contracts)
   react loop 主循环 · KernelContext 状态机 · abort · 终止判断 · round 计数
        │ 依赖注入（绝不 import 具体类）
        ▼ 扩展点契约 (kernel/contracts.ts，纯类型)
  Context（喂） │ Protocol（问+解+发delta） │ Tool（做）   ← 三只手
                          ╲ EventSink（实时输出导线，穿过 Protocol/Tool）
        ▲ 默认实现 (kernel-plugins/)
```

- **内核只回答"下一步"**：轮次推进、终止判断、round 计数、消息 append 时机。它不知道怎么组上下文/问模型/解析/调工具/发事件/落库。修改频率趋近于零。
- **三只手是内核调度的 Port**（星形三端点）。
- **EventSink 不是手**，是穿过 Protocol/Tool 内部的输出导线；内核几乎不用它（顶多最后 done/error）。

### 关键边界（多轮确认）

- **tool_calls 是 Protocol 向内核提交的"申请"，执行权在内核**。Protocol 不直连 Tool。数据流是星形 `Protocol→内核→Tool→内核→Protocol`，内核是唯一轴。一旦 Protocol→Tool 直连，循环就塌进 Protocol，内核名存实亡。
- **阶段一只有一个 Protocol**：现状"有工具/无工具"不是两种协议，是同一套 XML 内容协议 + 同一个 `StreamingRuntimeXmlParser` 的两种 outcome（有 `<tool_calls>` → 工具态，无 → final 态）。拆成两个插件只是把重复从"三方法"挪成"两类"，没真正消除。**统一成一个 Protocol 才连根拔除重复**。第二个协议要到阶段二（OpenAiHybridProtocol，解析逻辑根本不同）才出现。
- **阶段一统一按流式处理结果**：生产 `llmChatClient.stream` 恒存在，`runText` 两条非流式分支（`runToolCallingText` 原生 FC、`completeRequest` 非流式补全，同由 `!stream` 把守）皆为死代码，一并删除不迁移。有工具/无工具全部收敛到**单一流式 XML Protocol**——XML 解析统一屏蔽不同厂商的工具调用差异；原生 FC 的差异化解析推迟到阶段二（见九）。此处即"行为零变化"铁律的唯一已知例外：仅在 `stream` 缺席（生产不发生）时行为不再覆盖。

## 三、核心循环骨架（kernel/agent-kernel.ts）

```ts
async run(session: KernelSession): Promise<KernelResult> {
  const ctx = KernelContext.create(session);   // session.conversation 拷成可变 ctx.messages
  try {
    for (let round = 0; ; round++) {
      ctx.throwIfAborted();                                   // 轮首查中断
      ctx.appendMessages(await this.refresher.refresh(ctx));  // 补增量（后台通知+followup）
      await this.hooks.invoke("beforeModel", ctx, round);
      const outcome = await this.protocol.invoke(ctx, round); // 问模型+边流边解析+发delta，全在内部
      await this.hooks.invoke("afterModel", ctx, round);      // 取代 onModelRequestSuccess（刷 stable-prefix）
      if (outcome.kind === "tool_calls" && outcome.calls.length) {
        const observations = await this.tools.executeRound(ctx, round, outcome.calls);
        ctx.appendAssistant(outcome.assistantMessage);
        ctx.appendMessages(this.protocol.renderObservations(outcome.calls, observations)); // 形态归协议
        continue;
      }
      ctx.setFinalAnswer(outcome.finalAnswer ?? "");
      break;
    }
    this.events.emit({ type: "runtime.done", data: { /* content/agent_name/finish_reason */ } });
    return ctx.toResult();
  } catch (e) {
    if (isAbort(e)) throw e;                       // abort：现状不发 error 事件
    this.events.emit({ type: "runtime.error", data: { /* message/agent_name */ } });
    throw e;
  }
}
```

> 协议修复重试（`maxProtocolRepairAttempts=2` + `renderProtocolFeedbackMessage`）整段在单次 `invoke` 内部消化，**不递增内核 round**。中断/observation 拼回也在插件里，内核不感知。

## 四、扩展点契约（kernel/contracts.ts，纯类型）

```ts
export type AgentRuntimeEvent = /* 从 agent-runtime-core.ts 整体迁入，10 种类型不变 */;

interface Protocol {
  buildRequest(ctx): ChatCompletionRequest;                 // 吸收现 buildChatRequest（含 prompt 注入策略）
  invoke(ctx, round): Promise<KernelOutcome>;               // 问模型+边流边解析+发delta+修复重试
  renderObservations(calls, observations): ChatMessage[];   // observation→消息形态由协议决定
}
type KernelOutcome =
  | { kind: "final"; finalAnswer: string; assistantMessage: ChatMessage; finishReason: string|null }
  | { kind: "tool_calls"; calls: KernelToolCall[]; assistantMessage: ChatMessage; finishReason: string|null };

interface ToolProvider { executeRound(ctx, round, calls: KernelToolCall[]): Promise<KernelObservation[]>; }
interface EventSink { emit(event: AgentRuntimeEvent): void; }   // 零翻译，透传
interface MessageRefresher { refresh(ctx): Promise<ChatMessage[]>; }  // 取代 conversationUpdateProvider
interface HookRegistry { invoke(point: HookPoint, ...args): Promise<void>; register(point, fn): void; }
type HookPoint = "beforeModel" | "afterModel";

interface KernelSession {                                   // 一次 run 输入；conversation 为初始快照
  agent; provider; modelName; conversation: ChatMessage[];
  promptContext?; toolContext?; toolExecutor?; signal?;
  sessionId; runId; taskId: string|null; requestId: string|null; rootCallId; threadKey?: string;
}
```

`KernelContext`（kernel/kernel-context.ts）：持 session、**可变工作副本 messages**（初始=session.conversation 拷贝）、round、finalAnswer、scratch:Map。暴露 `appendMessages`/`appendAssistant`/`throwIfAborted`/`toResult`。注释明确：session.conversation 是快照，ctx.messages 是工作副本，插件不得 mutate session。

## 五、数据流双通道（流式核心）

一次流式 final answer 同时走两条路：

```
Protocol.invoke 内部（模型吐字中，invoke 尚未返回）:
  ├─ 实时通道：每 chunk 解析出 final_answer 片段 → eventSink.emit(output_delta)
  │            → publishRuntimeEvent → outbox → 前端逐字显示
  └─ 结果通道：流结束攒齐完整文本 → return { kind:"final", finalAnswer }
                                  ↓ 回内核 → setFinalAnswer → break → emit(runtime.done)
```

- **内核管"结果"，EventSink 管"过程"**。前端逐字显示靠 EventSink（过程中），不靠内核。
- 这正是 Model 与解析必须合体进 Protocol 的原因：发 delta 必须发生在解析的瞬间，而解析在 invoke 内部。切成 infer→interpret 两段（先拿完整响应再解析）会丢掉 delta 的发送时机。

## 六、EventSink 下游分流（由 publishRuntimeEvent 决定，非内核/Protocol）

`emit` 是统一入口，下游按事件类型分三类归宿（已读真实代码 event-publisher.ts 核对）：

| 事件 | 写消息表 | 写 run_step | 进 outbox 投递 |
|---|---|---|---|
| output_delta / first_token / intent_delta / error | 否 | 否 | 是 |
| tool_call / tool_result / intent_complete | 否 | 是（同事务） | 是（同事务） |
| assistant_intermediate / observation_complete | **是**（addMessage） | 否 | 否 |

> 共 10 种事件：上表 9 种 + `runtime.done`（由内核在循环结束后直接 `emit`）。`intent_complete` 经 `publishIntentComplete` 在单事务内 addRunStep + 两条 outbox 记录，归宿同 tool_call/tool_result。

> ⚠️ **`runtime.done` 是死事件（已核对 event-publisher.ts:185-346）**：`publishRuntimeEvent` 仅 9 个分支，无 `runtime.done`，经 `onEvent` 透传后被**静默丢弃**——既不落库也不投递。前端流结束的真实信号来自 `runText` 返回后的 `recordRunTerminal` → `deliverTerminalRecord`（run-engine.ts:410/432，Transactional Outbox 产出的 terminal 记录），与 `runtime.done` 无关。重构保留该类型只为维持"10 种不变"，新内核 `emit` 后同样被丢弃 → 行为等价（都丢）。**阶段二若要让前端感知循环结束须另行接线，不能依赖现状的 `runtime.done`**——此乃定稿前多轮对齐中漏掉的一处现状误述，现已订正。

- **tool_result vs observation_complete**：前者每个工具一条、结构化、给前端看（投递）；后者一整轮合并成一条纯文本、是喂回模型的 user 消息、给模型吃（只落库存档）。
- **最终落库（recordRunTerminal）是 Transactional Outbox**：addMessage + addRunStep + appendOutbox×N 在**同一事务**原子提交，由 run-engine 在 `kernel.run()` 返回后做。内核对持久化全程无感。
- Protocol/Tool 只管 emit，不需要知道某事件该落库还是投递——那是 publishRuntimeEvent 的职责。这是 EventSink 作为薄壳导线的价值。

## 七、两个调用方接入

三个回调归到内核扩展点：

| 现状回调 | 新归属 |
|---|---|
| `onEvent` → publishRuntimeEvent | `EventSink.emit`（透传，零翻译） |
| `conversationUpdateProvider` | `MessageRefresher.refresh`（循环②步） |
| `onModelRequestSuccess`（刷 stable-prefix） | `HookRegistry` afterModel hook |

- **run-engine.executeRun**：`agentRuntimeCore.runText(...)` → `agentKernel.run(session)`；注入聚合 refresher + RuntimeEventSink + afterModel hook。`kernel.run` 返回后才 recordRunTerminal。
- **delegation.executeChildRun**：同样换 kernel.run；注入 **NullEventSink**（child 静默，现状行为不能改）+ noop refresher。
- `refreshStablePrefixCache` 两处重复 → 抽 `kernel/stable-prefix.ts` 共用。

## 八、文件改动清单

### 新建
- `kernel/contracts.ts` — 全部扩展点接口 + KernelSession/KernelContext/KernelOutcome 类型 + 迁入的 AgentRuntimeEvent（纯类型）。
- `kernel/agent-kernel.ts` — AgentKernel 类 + 循环骨架。
- `kernel/kernel-context.ts` — KernelContext 状态机。
- `kernel/hook-registry.ts` — HookRegistry 默认实现（顺序执行）。
- `kernel/stable-prefix.ts` — refreshStablePrefixCache 共享函数。
- `kernel-plugins/protocol/xml-protocol.ts` — **唯一协议**。从 runXmlToolCallingText + runXmlStreamRound + runStreamingText 合并迁入（含修复重试、流式发 delta、renderObservations、buildRequest）。无工具是 invoke 无 tool_calls 的自然结果，不再是独立路径。
- `kernel-plugins/protocol/select-protocol.ts` — selectProtocol(provider 配置)。阶段一退化为恒返回 XmlProtocol；签名预留，阶段二才真正分派。
- `kernel-plugins/tools/runtime-tool-provider.ts` — 包装 executeToolCallRound（不动），注入 EventSink 接回 tool_call/tool_result。
- `kernel-plugins/events/runtime-event-sink.ts` — RuntimeEventSink（透传 publishRuntimeEvent）+ NullEventSink。

### 改造
- `agent-runtime-core.ts` — **删除类**，全迁出，无兼容壳。两条非流式分支——native-fc 顶层路径 `runToolCallingText` 与非流式补全 `completeRequest`——整段删除不迁移（同由 `!stream` 把守，生产 stream 恒存在 → 死代码），均不并入 xml-protocol。类型迁 contracts.ts。
- `agent-execution-service/run-engine.ts` — executeRun 换 kernel.run；回调迁移见上表。
- `agent-delegation-service.ts` — executeChildRun 换 kernel.run；NullEventSink；stable-prefix 改用共享函数。
- `agent-execution-service/event-publisher.ts` — publishRuntimeEvent 内部**不动**；仅 import 的 AgentRuntimeEvent 来源改 contracts.ts。
- `runtime/runtime-container.ts` — 装配 AgentKernel 替换 new AgentRuntimeCore(L192)；delegation 构造参数改为 AgentKernel。

## 九、阶段二预留（不在阶段一做）

- **配置驱动协议选择**：selectProtocol 读 `provider_type` + `supports_function_calling`。现状 shouldRunXmlToolLoop 从不读 supports_function_calling，导致 fc 能力被忽略、强制走 XML——阶段二修正。
- **协议 = prompt 注入 + 解析 同源**：走 native 工具时 buildRuntimeMessages 不注入 XML `<tool_calls>` 说明（加 toolInstructionMode 开关），LLM 不知道可用 XML 调工具。
- **新协议**：OpenAiHybridProtocol（native fc 工具 + XML 内容，先做）→ AnthropicHybridProtocol（tool_use，后做）。需先给流式解析器补 fc/tool_use 增量拼接（现 readOpenAiCompatibleStream 只抽 content delta）。
- 阶段一只把接缝（selectProtocol 签名、buildRequest 归 Protocol）预留好，不动任何行为。

## 十、验收

1. `cd backend-ts && npm run typecheck`（及 typecheck:test）— 零类型错误。
2. `npm run build` — 产物可生成。
3. 手动端到端（npm run dev + /api/agent/stream）：
   - XML 工具对话：流式输出 + 工具调用 + observation 回填 + 最终回答。
   - 无工具纯流式回答。
   - 事件序列与现状一致（first_token/output_delta/tool_call/tool_result/observation_complete/done）。
   - abort 中途停止正常中断、状态置 interrupted。
   - 子 agent 委派（agent）跑通且 child 不发 runtime 事件。
4. **确认无依赖非流式回退的测试 mock**：`LlmChatClient.stream` 类型上可选（llm-chat-client.ts:66），删除 `runToolCallingText`/`completeRequest` 后，测试中"注入无 `stream` 的 mock → 原回退 `completeRequest`"的路径不再存在。跑全量 `npm test`，若存在此类 mock 须改为流式 mock，否则测试会静默走 XmlProtocol 新路径而无人察觉。

## 十一、风险与注意

- **流式时机**：迁移时逐字保留 streamRequest onChunk 回调里的 emit，绝不改成"攒完整段再一次性 emit"（会从流式退化成整段炸出）。
- **事件等价**：复用 AgentRuntimeEvent + 透传 publishRuntimeEvent，从根上避免字段漂移。
- **协议修复重试**：保留 maxProtocolRepairAttempts=2 与 renderProtocolFeedbackMessage，整段在单次 invoke 内消化，不递增 round。
- **observation 形态**：XML 单条 user，由 renderObservations 决定，内核只 appendMessages。
- **tool 事件连接点**：ToolProvider 必须持 EventSink，否则 tool_call/tool_result 断流；后台 waitForToolResult 分支保留。
- **child 静默**：delegation 用 NullEventSink，勿改为发事件。
- **KernelSession null 容忍**：child 的 requestId/taskId 可能为 null。
