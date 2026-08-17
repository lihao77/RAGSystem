# @ragsystem/agent-sdk 设计

> 可嵌入的 agent 运行时 SDK，是 backend-ts agent 能力的**核心功能子集**：行为一致，
> 但剥离衍生功能（配置系统 / 知识库 / skill / mcp / delegation / 审批 / outbox 投递）。
>
> 与旧设计稿的根本差异：旧稿把上下文管理 / memory / 提示词组装当"产品逻辑"排除在 SDK 外，
> 只留裸 ReAct 内核。本设计**反转该边界**——这些是 agent 的核心功能，必须内置。`builtin/session`
> 玩具版（不与 backend-ts 对齐、无人消费）废除。

---

## 1. 定位与边界

### 定位

agent-sdk = backend-ts agent 运行时的核心功能子集。一个进程 `createRuntime(opts).run(input)`
就能跑通 ReAct 循环：自带上下文装配 / 提示词组装 / memory / 压缩 / 工具调度 / 消息持久化 /
统一事件管线，不依赖 Fastify / WS / outbox / store 注入。backend-ts 改造为 SDK 的消费者，
注入衍生能力（重型工具 / 知识库 / skill / 审批 / 多 agent 委派）并消费 SDK 产出的事件流。

### 内置（调用者不传，SDK 自己跑）

- 内置 store：message / run_step / run 的存储 + 自带事务（node:sqlite 单库，按 dataRoot 落盘）
- 统一事件管线：单一消费点，事务内原子写 step+message；实时事件走返回的事件流
- 上下文管理：`context-builder`（recent-messages / 正式压缩视图 / stable-prefix 指纹去重 / sources 数组）+ `AgentContextService` 装配门面
- 提示词组装：`prompt-builder` / sections / system prompt 构造 / 协议说明 / memory 前缀注入
- memory：`MemoryStore`（文件系统多作用域）+ `MemoryIndexContextSource`（上下文 source）+ memory 工具
- 压缩：`context-compression`（门控阈值 / 段选择 / tier 候选解析去重 / 有损保护）+ 循环内 beforeModel hook
- 工具调度：`RuntimeToolProvider` / tool-round-executor
- 悬空 tool_use 收口：interrupted 时扫历史补配对 tool_result（厂商 API 要求 tool_use 紧跟 tool_result）

### 剥离（不进 SDK）

- 配置系统：`AgentConfig` 的 YAML / team-store / configs（调用者投影成核心子集传入）
- 知识库：RAG retrieval
- skill：技能系统
- mcp：外部工具服务器
- 多 agent 委派：delegation / agent / list_child_agents
- 审批：PendingInteractionService
- outbox / WS 投递：claim / 重试 / 实时分发（backend-ts 读 SDK 事件流自己玩，SDK 不认识这些概念）
- 重型工具链：execute_code / execute_bash / 文件工具等（调用者作为 tools 注入）

---

## 2. 调用者传参（进）

调用者只传核心依赖 + 已解析的工具 + 可选路径：

```ts
const runtime = createRuntime({
  // —— LLM（LlmClient 端口，调用方注入）——
  llm,                       // LlmClient
  provider,                  // ProviderConfig（key/baseURL/provider_type/supportsFC/...）
  modelName,

  // —— agent 核心配置子集（投影自 AgentConfig，见 §3）——
  profile: {
    agentName, displayName,
    llmTiers,                // 全量解析的扁平 tier 表（投影算死，内核零兜底）；参数/预算/摘要候选的真相源
    memory,                  // { auto_inject, allowed_scopes, write_scopes, archive_scopes }
    behavior,                // { system_prompt, compression_trigger_ratio, summarize_max_tokens, preserve_recent_turns, ... }
  },

  // —— 工具（已解析的实例，非配置系统按名解析）——
  tools,                     // ToolExecutor

  // —— 内置 store ——
  dataRoot?,                // 数据根目录；默认 ~/.ragsystem，store 在其下建库
});

const handle = runtime.run({
  sessionId,                 // SDK 自管；resume 既有 session
  task,                      // 用户任务
  messages?,                 // 初始会话快照（可选；不传则从 store 加载）
  runId?, rootCallId?,       // 身份盖戳（可选，默认生成）
  threadKey?,                // root/child 归属（默认 root）
  parentCallId?,             // child run 挂父（lineage）
  signal?,
});

// 调用者从这里读 KernelEvent，自己翻译成 Envelope/可视化 + outbox / WS（SDK 不认识投递）
for await (const event of handle.events) { ... }
const { content, finish_reason, metadata } = await handle.result;
```

---

## 3. AgentProfile —— AgentConfig 核心投影

backend-ts 的 `AgentConfig`（zod）混了核心字段与衍生字段。SDK 取核心子集，定义干净的
`AgentProfile`，调用者投影后传入：

| AgentConfig 字段 | 处理 |
|---|---|
| `agent_name` / `display_name` | 进 profile（身份） |
| `llm_tiers` | 进 profile（投影解析后传：tier 引用→完整 provider 内联，selectLlm 替换 default） |
| `memory` | 进 profile（memory 是核心功能） |
| `custom_params.behavior` | 进 profile（system_prompt + 压缩阈值） |
| `custom_params`（其余） | 进 profile（透传 dict） |
| `tools.enabled_tools` | **不进**——调用者传已解析的 tools 实例 |
| `skills` / `mcp` / `knowledge_base` | **不进**（衍生） |
| `delegation` / `tasks` | **不进**（衍生） |

`llm_tiers` 进 SDK 前一次性解析为**全量已决的扁平 tier 表**——每档已内联完整 provider、
参数全填、缺档补齐。内核零兜底，只按 tier 名索引取值；所有"多源回落"集中到投影层：

- provider 引用 → 完整 ModelProviderConfig（解析自 providers 表）
- selectLlm → 解析为 `(provider, modelName)` 替换 default
- 字段回落（tier → default → system）、extra_params merge → 投影时算死，每档产出单一标量
- 缺档（如 fast 未配）→ 投影时用 default 补齐，或删档

解析后内核三处用法退化为纯读 / 纯算术（不再含多源 fallback）：
- LLM 参数：读 `tiers[tier].temperature / maxCompletionTokens / extraParams`（`resolveTierLlmParams` 兜底链删除）
- 上下文预算：`resolveContextBudget` 按 `tiers.default.maxContextTokens`（provider 最大上下文）做纯算术；窗口缺失或负数预算用内置兜底
- 摘要候选：读 `[tiers.fast, tiers.default]` 去重（`resolveSummaryTierCandidates` 的 provider 解析 + system 兜底删除）

> 顶层 `provider/modelName`（§2）即 `tiers.default`，单一真相、不重复推导。

**契约约束**：投影后 tier 表每档（至少 default）全量已决——provider + modelName + 参数 + maxContextTokens 
无一为空。投影是唯一解析点；SDK 内核不含任何 fallback / 多源回落（system 兜底、provider 查找、缺档推断均不出现在内核）。

投影示例（backend-ts 侧，集中所有兜底）：

```ts
interface ResolvedTier {
  provider: ModelProviderConfig;        // 已解析，完整（非引用字符串）
  modelName: string;
  temperature: number | null;
  maxCompletionTokens: number | null;
  maxContextTokens: number | null;       // 投影算死（tier → provider → system 回落完）
  extraParams: Record<string, unknown>; // 投影 merge 完
}

function projectLlmTiers(agent, selectedLlm, providers, systemLlm): Record<string, ResolvedTier> {
  const raw = agent.llm_tiers ?? {};
  const defaultTier = selectedLlm
    ? resolveSelectedAsTier(selectedLlm, providers)
    : resolveTier(raw.default, providers, systemLlm);      // 兜底全在这
  const fast = resolveTier(raw.fast, providers, systemLlm) ?? defaultTier; // fast 缺则补 default
  return { default: defaultTier, fast };                   // 内核只读结果，零兜底
}
```

---

## 4. 架构总览

```
createRuntime({ llm, provider, modelName, profile, tools, dataRoot? })
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│  run(input) 包装层                                            │
│   生成 runId/rootCallId → 内置 store.createRun                │
│   → 挂 beforeModel hook（压缩 + refresher）                   │
│   → AgentKernel.run                                          │
│        │                                                       │
│        │  emit(KernelEvent)        ← 运行时语义事件，透传不翻译  │
│        ▼                                                       │
│   ┌────────────────────────────────────────────┐              │
│   │  统一消费点（单一 Dispatcher）              │              │
│   │  按事件类型分流：                            │              │
│   │   - realtime-only（生命周期/delta/error）   │              │
│   │       → 只 push 事件流                      │              │
│   │   - message-only（assistant/observation）   │              │
│   │       → store.runInTransaction(addMessage) │              │
│   │   - step（intent_complete/tool_call/result）│              │
│   │       → store.runInTransaction(addRunStep) │              │
│   │       + push 事件流                         │              │
│   └────────────────────────────────────────────┘              │
│        │                                                       │
│   终态收口（interrupted 时）：                                  │
│     store.listMessages 扫悬空 tool_use → 补 tool_result       │
│     （同终态 tx）                                              │
│   → recordTerminal（final message + run_step + updateRunStatus）│
└──────────────────────────────────────────────────────────────┘
        │
        ▼  handle.events（AsyncIterable<KernelEvent>，原始透传）
   调用者（backend-ts，SDK 视野外）
      event → 自己的 outbox 表 → claim/重试/WS 投递
      （SDK 不认识 outbox / WS，原子性与投递是两件事）
```

---

## 5. 内置 store

SDK 自己拥有 message / run_step / run 的存储，自带事务，不注入端口。

### 接口形态（对齐 backend-ts `ConversationStoreTransaction` 形状）

```ts
interface RuntimeStore {
  runInTransaction<T>(fn: (tx: RuntimeTx) => T): T;
  // 读面（上下文装配 + 悬空收口用）
  listMessages(sessionId: string, threadKey?: string, limit?: number): MessageInfo[];
  getMessageById(sessionId: string, messageId: string): MessageInfo | null;
  createRun(...): void;  // run 起始
}

interface RuntimeTx {
  addMessage(input): MessageInfo;
  addRunStep(input): RunStepRecord;
  updateRunStatus(runId, sessionId, status, finalMessageId?): boolean;
  updateRunStepsMessageId(sessionId, runId, messageId): number;
  insertCompressionMessage(input): MessageInfo;  // 压缩摘要落库
}
```

### 实现

- 单一实现：node:sqlite 单库（DatabaseSync），按 dataRoot（默认 ~/.ragsystem）在其下建库。
  schema 对齐 backend-ts messages/run_step/run 表结构（node:sqlite 同驱动、同 WAL/foreign_keys 设置），
  表结构，便于 backend-ts 直读同一文件作消费者）。事务=SQLite 事务。

> 决策：SDK 的内置 store 即权威表。backend-ts 改造为消费者后，**直读 SDK 的 store**
> （同库同 schema），不做 dual-write。`buildSynchronousResult` / API 查执行历史改成查 SDK store。

---

## 6. 统一事件管线（核心）

### 设计原则

1. **内核事件透传**：内核发 `KernelEvent`（运行时语义：first_token / output_delta / tool_call /
   tool_result / intent_complete / error 等），SDK **不翻译**成 Envelope。
2. **单一消费点**：一个 Dispatcher 处理所有 KernelEvent，按类型分流（落库 + 推流）。
3. **SDK 自己维护 step+message 的原子性**：`runInTransaction` 内同事务写两者。
4. **Dispatcher 只落库 + 推流，不翻译**：把**原始 KernelEvent** 推进 `handle.events` 流；
   翻译成 Envelope（或别的可视化形态）是消费端（backend-ts）的事——消费端可能不止消费
   Envelope 一种类型，故 SDK 不替它做翻译决策，只透传语义完整的 KernelEvent。
5. **outbox 不进 SDK**：实时投递是调用者的事。
6. **悬空收口进 SDK**：interrupted 时扫历史补配对 tool_result，保证 message 序列完整。

### 事件分流表

| KernelEvent | 落库动作（tx 内） |
|---|---|
| `run_started` / `run_ended` | createRun / updateRunStatus |
| `agent_started` / `agent_ended` | — |
| `first_token` / `output_delta` / `intent_delta` | — |
| `intent_complete` | addRunStep(intent) |
| `tool_call` | addRunStep(tool, phase:start) |
| `tool_result` | addRunStep(tool, phase:end) |
| `error` | — |
| `assistant_message` | addMessage(intent) |
| `observation_message` | addMessage(observation) |

> **所有 KernelEvent 一律推流**（`handle.events`）。Dispatcher 不替消费端决定"哪条值得推"——
落库是 SDK 的存储职责（独立副产物），推流是"全部推"。消费端自己决定消费哪些、丢弃哪些。
当前 backend-ts 只把其中一部分翻译成 Envelope 投递前端，但这是消费端的取舍，不影响 SDK 全推。

### 原子边界

落库与推流解耦，是两件独立的事：
- **落库**：Dispatcher 在 `runInTransaction` 内写 step+message 两者原子（设计稿 §6 原则 3）。
- **推流**：把**原始 KernelEvent** 推进 `handle.events`，与 tx 提交时机不耦合、与落库行为解耦——
  即便某事件不落库（如 delta），也照样推；即便某事件落库（如 assistant_message），也照样推。
- **翻译**：消费端把 KernelEvent 翻译成 Envelope（或别的可视化形态），是第三件事，SDK 不管（§6 原则 4）。
三者各司其职。

### 悬空 tool_use 收口

run interrupted 时，Dispatcher 终态处理在**终态 tx 内**：
1. `store.listMessages` 扫该 run 的 assistant(tool_calls) 中无配对 role:tool(tool_call_id) 的悬空 tool_use
2. 补 `tool_result` 的 message + step（同 tx）
3. 落 interrupted assistant 锚点消息
4. updateRunStatus(interrupted)

保证厂商 API 下次加载历史不拒绝（tool_use 必须紧跟 tool_result）。逻辑迁自 backend-ts
`ExecutionRecorder.recordFailed`。

---

## 7. 上下文管理（内置）

### context-builder（sources 数组）

迁入：`AgentContextBuilder` + sources：
- `RecentMessagesContextSource`：从 store 读历史并应用已落库的正式压缩视图
- `MemoryIndexContextSource`：memory 前缀注入（见 §8）
- `EmptyMemoryContextSource`：空实现顶位

`buildContext` 按 sources 数组顺序组装 conversation，产 stable-prefix 指纹。

### AgentContextService（装配门面）

迁入 `AgentContextService`，三能力：
- `prepare`：run 前置构建上下文 + 算 usage/budget，不压缩
- `recompact`：循环内重判，超阈后执行 LLM 压缩并从正式压缩视图重建
- `buildUsage` / `snapshotContext`：只读快照

依赖：内置 store（读历史）+ compression service + profile.llmTiers（算预算）。

### 提示词组装（prompt-builder）

迁入 `buildFullSystemPrompt` + sections + `buildModelMessages` + `DefaultContext`：
- system prompt 构造（system/goal/principles/actions/tools/skills/output/rules）
- stable context 剥离 + memory 前缀 + 协议说明组合
- 会话渲染（protocol.toModelMessages）

**解耦**：原代码读 `agent.custom_params.behavior.system_prompt` → 改读 `profile.behavior.system_prompt`。
delegation / skill 相关 section 在 SDK 内条件性产出（profile 不含这些字段时跳过）。

---

## 8. memory（内置）

迁入整套（行为对齐 backend-ts）：

- `MemoryStore`（`IMemoryStore`）：文件系统多作用域（team / session / agent / workspace），
  `dataRoot` 默认 `~/.ragsystem`。loadIndexHead / saveMemory / archiveMemory / listEntries
- `MemoryIndexContextSource`：上下文 source，按 profile.memory 配置加载 scope 前缀 +
  指纹缓存（写 session metadata）
- memory 工具：save_memory / list_memory / archive_memory（作为 SDK 自带工具，或由调用者注入）

memory 配置（profile.memory）驱动：auto_inject / allowed_scopes / write_scopes / archive_scopes。
stable-prefix 指纹含 memory 前缀指纹；正式压缩只替换 history 视图，不改写 memory 前缀快照。

---

## 9. 压缩（内置）

### context-compression

迁入 `AgentContextCompressionService`：
- `compressIfNeeded`：门控（historyTokens < threshold 跳过）→ 段选择（跳过开头既有摘要、
  保留最近 N 轮）→ LLM 摘要（tier 候选 fast→default 去重，前级失败降级）→ 落 store
  （insertCompressionMessage，replacesUpToSeq）→ 有损保护（摘要失败保留完整历史）
- `forceCompactSession`：/compact 手动强制
- `resolveContextBudget`：按 `tiers.default.maxContextTokens`（provider 最大上下文）做纯算术；窗口缺失或预算为负时用内置 4000 兜底，不再接受最小预算配置

```ts
// 上下文预算 = max(floor(tiers.default.maxContextTokens × 0.9) − systemPromptTokens, 4000)
```

### 循环内 hook

迁入 `createCompactionHook`（beforeModel）：每轮问模型前估算工作副本 token，超阈值才触发
recompact（micro-first），整体替换工作副本（补回本轮未入库的背景通知）。

---

## 10. 工具调度

已就绪（SDK 已有），对齐收尾：
- `RuntimeToolProvider`（toolExecutor 端口 + ObservationStrategy + 调度器）
- `tool-round-executor`
- 调用者注入 ToolExecutor（backend-ts 的 RuntimeToolBridge 适配重型工具）

---

## 11. 目录骨架

```
packages/agent-sdk/src/
  index.ts                         # createRuntime + 类型 re-export
  runtime.ts                       # 入口：createRuntime(opts).run(input)
  contracts.ts                     # 端口：ToolExecutor/Protocol/Context + KernelEvent（透传不翻译）+ RuntimeSession
  kernel.ts                        # ReAct 主循环
  kernel-context.ts                # 状态机
  dispatcher.ts                    # 统一消费点：分流 + tx + 事件流 + 悬空收口
  store/                           # ★ 内置存储
    runtime-store.ts               # RuntimeStore 接口（SQLite 实现）
    sqlite-store.ts                # 持久化（node:sqlite DatabaseSync，同库同 schema）
    schema.ts                      # messages/run_step/run 表结构
  context/                         # ★ 上下文管理（迁入）
    context-builder.ts             # AgentContextBuilder + sources
    context-service.ts             # AgentContextService 装配门面
    default-context.ts             # DefaultContext（buildMessages）
    message-builder.ts             # buildModelMessages（渲染原语）
  prompt/                          # ★ 提示词组装（迁入）
    sections.ts                    # 中文 sections
    prompt-builder.ts              # buildFullSystemPrompt
    tool-format.ts
    types.ts
  memory/                          # ★ memory（迁入）
    memory-store.ts                # MemoryStore（IMemoryStore）
    memory-index-source.ts         # 上下文 source
    memory-prefix.ts               # 指纹 + 渲染
    memory-tools.ts                # save/list/archive 工具
  compression/                     # ★ 压缩（迁入）
    context-compression.ts         # AgentContextCompressionService
    compaction-hook.ts             # beforeModel hook
    token-estimate.ts
  llm-params/                      # tier 表读取（薄层，零兜底）
    tier-params.ts                 # 读 tiers[tier]（原兜底链已移到投影）
    budget.ts                      # tiers.default 已决值 → 纯算术
    summary-tier.ts                # 读 [tiers.fast, tiers.default] 去重
  protocol/                        # 已有：Xml/NativeHybrid + 渲染原语
  tools/                           # 已有：RuntimeToolProvider/tool-round-executor
  types.ts                         # AgentProfile + 行为配置类型
```

废 `builtin/session`（玩具 SessionStore/compaction），不进新结构。

---

## 12. 范围与顺序

### 第一包落地顺序（按依赖）

1. **内置 store**（store/）：node:sqlite 单库（dataRoot），自带 tx。其余全依赖它。
2. **统一事件管线**（dispatcher.ts）：分流 + tx 原子 + 悬空收口 + 事件流。骨架。
3. **tier 表读取**（llm-params/）：投影已算死，内核薄读 + 纯算术。
4. **上下文管理 + 提示词组装**（context/ + prompt/）：解耦 AgentConfig → profile。
5. **memory**（memory/）：整块迁入。
6. **压缩**（compression/）：依赖 tier + store。
7. **createRuntime/run 调用面重接**：llm + provider + modelName + profile + tools + dataRoot。
8. **编译 + demo 闭环验证**。

### 不进第一包

多 agent 委派 / 审批 / outbox 投递 / 知识库 / skill / 重型工具 / 后续 backend-ts 消费切换。
backend-ts 切换为消费者是独立的后续工程（设计文档原 §10 的改造范围，但不在本 SDK 第一包）。
