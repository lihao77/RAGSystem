# TS 端智能体工具体系重构（Tool-centric · Zod · 输入校验/并发调度/权限三层合议）

> 状态：主体方向已落地（2026-08-17 核对）；残留差异见下注
> 范围：`backend-ts` 智能体工具体系与调用体系
> 参考：`D:\python\claude-code-source-code-main`（Claude Code 工具体系设计）

> **落地核对注记**：Tool-centric 富模型已在 `packages/agent-sdk/src/tools/tool.ts` 实现（Tool 接口、`inputSchema` 输入校验 `validation.ts`、三态权限 `ToolAccessDecision`、并发策略 `ToolConcurrencyPolicy`、hooks registry）。与方案的差异：SDK 刻意不依赖 Zod 包，`InputSchema` 采用鸭子类型兼容 Zod 的 `safeParse` 形状。下文为原始方案，细节以 `packages/agent-sdk` 代码为准。

## Context（为什么做这次重构）

`backend-ts` 已把工具体系迁到 **“Provider 中心 + 中央执行器”**：`RuntimeToolDefinition` 是纯数据（定义集中在 `runtime-tool-bridge/registry.ts`），行为散落在 11 个 Provider 的 `executeTool` 里。对照 Claude Code 源码，存在 4 个结构性短板：

1. **定义与行为分离**：一个工具的“全貌”要跨 `registry.ts`(定义) + provider(分发) + service(实现) 三处拼，schema 无法约束行为。
2. **执行时不校验输入**：`parameters` JSON Schema 只 advertise 给 LLM，`call.arguments` 直接灌进 service，模型传错参 → 运行时崩溃，无结构化报错回喂。
3. **并发“按协议”而非“按工具”**：调度靠轮次级双开关 `dependencyAware`/`parallelIndependent`（`tool-round-executor.ts:89`）。原生工具路径**一律串行**，无法识别“多个只读检索可并行、夹一个写操作才串行”。
4. **权限集中无法下沉**：全靠 `PermissionPolicyService`(riskLevel+mode+pattern)。工具贡献不了自己的权限逻辑，导致 Bash 被特判成 `handlesOwnExecution`+`executeToolWithHooks`（`runtime-tool-bridge.ts:119/167），形成分叉代码路径。此外 `allowed_callers` 字段**当前未被强制**（`execute_code` 用硬编码白名单 `CODE_CALLABLE_TOOLS`）。

**目标**：彻底重写为 **Tool-centric** —— 每个工具是自包含单元（定义+Zod schema+行为合一），Provider 层废弃，改为扁平注册表 + Map 索引。本轮落地三个子系统：**输入校验（Zod 单一事实源）、并发调度（按输入判定并发安全）、权限三层合议**。结果渲染/大结果落盘（`observation.ts`）与子智能体隔离**本轮不动**，工具仍返回现有 `ToolExecutionResult`，对 `agent-runtime-core` 的 observation 链路零改动。

## 目标架构

新建 `backend-ts/src/services/runtime/tools/`：

```
runtime/tools/
├── tool.ts                # RuntimeTool 接口 + buildTool() 工厂（默认值 + zodToJsonSchema 派生 parameters）
├── tool-registry.ts       # createToolRegistry(deps) → RuntimeTool[]；Map 索引；filterForAgent；classifyConcurrency
├── tool-scheduler.ts      # partitionToolCalls + 统一并发管线（替代双开关）
├── tool-permissions.ts    # 三层合议：tool.checkPermissions → PermissionPolicyService → Hook
├── validation.ts          # Zod safeParse → 结构化 InputValidationError(ToolExecutionResult)
└── defs/                  # 每个工具一个文件，createXxxTool(deps): RuntimeTool
    ├── read-file.tool.ts  ├── execute-bash.tool.ts  ├── search-knowledge-base.tool.ts …
```

### RuntimeTool 接口（`tool.ts`，最终版）

```typescript
export interface RuntimeTool<I = Record<string, unknown>, O = unknown> {
  // 定义（沿用 RuntimeToolDefinition 的描述性字段，便于 listVisibleTools 投影）
  readonly name: string;
  readonly description: string;
  readonly inputSchema?: z.ZodType<I>;          // 单一事实源；MCP 工具可缺省
  readonly inputJSONSchema?: Record<string, unknown>; // MCP 逃生口（与 inputSchema 二选一）
  readonly riskLevel?: RiskLevel;
  readonly allowedCallers?: ToolCaller[];       // 默认 ["direct"]，在调度入口强制
  readonly approvalExempt?: boolean;
  readonly source?: ToolSource; readonly category?: string;
  readonly usageContract?: string[]; readonly examples?: unknown[];
  readonly extendedUsage?: string; readonly returns?: RuntimeToolReturns;
  readonly parameters: Record<string, unknown>; // buildTool 自动从 inputSchema 派生
  // 行为（可选，缺省走默认）
  isVisible?(agent: AgentConfig | null): boolean;     // 默认 enabled_tools.has(name)
  isReadOnly?(input: I): boolean;                     // 默认 false
  isConcurrencySafe?(input: I): boolean;              // 默认 false
  checkPermissions?(input: I, ctx: Ctx): ToolPermissionResult; // {behavior:"allow"|"deny"|"ask",reason?}
  call(input: I, ctx: Ctx): Promise<ToolExecutionResult<O>>;
}
export function buildTool<I,O>(def): RuntimeTool<I,O> // 填充默认 + parameters = zodToJsonSchema(def.inputSchema)
```

- **DI 模式**：每个工具文件导出 `createReadFileTool(documentTools)` 等工厂，闭包捕获 service（替代 Provider 构造注入）。`createToolRegistry(deps)` 用 `RuntimeToolBridge` 现有的同一组 service 构建工具数组，service 为 null 时跳过（沿用现有 null 检查）。
- **可见性**：多数工具默认 `enabled_tools.has(name)`；knowledge/memory/delegation 等带额外门控（`knowledge_base.enabled`、memory scopes、`delegation.enabled_agents`）的工具实现 `isVisible(agent)`。
- **描述性元数据**（`usageContract`/`examples`/`extendedUsage`/`returns`）必须随工具迁移——它们进系统提示词，丢失会改变模型行为。

## 三大子系统改造

### 1. 输入校验（`validation.ts`）
执行前置：`tool.inputSchema.safeParse(arguments)`。失败 → 构造结构化 `InputValidationError`（`success:false, output_type:"error"`，把 Zod issues 格式化进 `summary`/`content`），**不进 `tool.call`**，直接作为 observation 回喂模型。MCP 工具（无 `inputSchema`）跳过校验。`parameters` 由 `zod-to-json-schema` 派生 → LLM 看到的与运行时校验的永远一致。

### 2. 并发调度（`tool-scheduler.ts`，移植 Claude Code partitionToolCalls）
删除 `executeToolCallRound` 的 `dependencyAware`/`parallelIndependent` 双开关，XML 与原生路径**共用统一管线**：
- 外层保留现有 `{result_N}` 依赖分层（`buildExecutionBatches`）。
- 每个 ready 批内，按 `isReadOnly(input) && isConcurrencySafe(input)` 把**连续**的并发安全调用合批 `Promise.all`（上限 `RUNTIME_MAX_TOOL_CONCURRENCY`，默认 8）；遇写操作/不安全工具断批串行。
- 并发判定需要 parsed input + 工具 flag，由 bridge 提供新方法 `classifyConcurrency(call, ctx)`（内部 lookup+safeParse+flags，失败回退 false=串行），scheduler 保持 dumb。
- 收益：原生工具路径也能自动并行只读检索（`glob`/`grep`/`read_file`/`search_knowledge_base`），写操作仍串行。

`agent-runtime-core.ts` 的 `runXmlToolCallingText`(行~306) 和 `runToolCallingText`(行~404) 改为不再传两个 flag；observation 拼回逻辑不变。

### 3. 权限三层合议（`tool-permissions.ts`）
`runtime-tool-bridge.ts` 删除 `handlesOwnExecution` / `executeToolWithHooks` 分叉，统一一条 `executeTool`。合议顺序：

```
tool.checkPermissions(input,ctx) → deny: 立即拒(errorResult)
        ↓ allow / ask(→ forceAsk)
PermissionPolicyService.evaluateToolApproval(riskLevel+mode+pattern+外部路径)
        ↓ 取更严者
Hook(before/after_permission) 可升降级（沿用 applyHookPermissionDecision）
        ↓ ask → pendingInteractions.waitForApproval（沿用 executeToolAfterApproval）
tool.call(input,ctx) → before/after_execute / on_error hook（沿用）
```

- **Bash 去特判**：`prepareExecution` 的命令分类迁入 `execute-bash.tool.ts` 的 `checkPermissions`（分类→allow/ask）与 `call`（`prepareExecution`+`executePlan`）。Bash `isConcurrencySafe` 恒 false（保守串行）。
- **allowed_callers 真正强制**：`RuntimeToolExecutionContext` 新增 `caller?: "direct"|"code_execution"`（默认 direct）。`code-execution-tool-service.callCodeCallableTool` 改为在 ctx 设 `caller:"code_execution"` 调用 bridge；bridge 入口校验 `tool.allowedCallers.includes(ctx.caller)`，不符 → 拒。删除硬编码 `CODE_CALLABLE_TOOLS`，改由 `preview_data_structure`/`glob` 声明 `allowedCallers:["direct","code_execution"]`。

## 切割策略（增量、不停机）

`RuntimeToolBridge` 改造为**注册表驱动**，过渡期新旧并存：已迁移工具走新注册表，未迁移工具暂回退旧 Provider（`canHandle`）。每迁完一组删对应 Provider，最终删除 `runtime-tool-providers/` 与 `registry.ts` 的纯数据定义。

- **A. 地基（无行为变化）**：加 `zod-to-json-schema` 依赖；写 `tool.ts`/`buildTool`/`validation.ts`/`tool-registry.ts` 骨架；`RuntimeToolExecutor` 接口加 `classifyConcurrency?`，`Ctx` 加 `caller?`；bridge 内建 Map 索引 + 新旧并存查找。`listVisibleTools` 投影 `RuntimeTool→RuntimeToolDefinition`（外部契约不破，前端/XML 协议零改动）。
- **B. 调度+校验切换**：上线 `tool-scheduler.ts`，`executeToolCallRound` 去双开关；bridge 执行入口接 Zod 校验。对新旧工具都生效（旧工具 `classifyConcurrency` 回退串行）。
- **C. 权限合议**：上线 `tool-permissions.ts`，统一 bridge `executeTool`；迁移 Bash 去特判；`caller`/`allowedCallers` 强制。
- **D. 逐组迁移工具到 `defs/`**：document → local-search → memory → knowledge → code-execution → skill → task → delegation → request-user-input → mcp(动态包装)。每组：JSON Schema 翻译成 Zod + 搬 service dispatch 进 `call` + 标 `isReadOnly`/`isConcurrencySafe`/`allowedCallers`。

### 关键文件
- 新增：`runtime/tools/{tool,tool-registry,tool-scheduler,tool-permissions,validation}.ts` + `defs/*.tool.ts`(≈40)
- 改造：`runtime-tool-bridge.ts`（注册表驱动、统一执行、合议）、`runtime-tool-types.ts`（`RuntimeToolExecutor`+`Ctx` 扩展）、`agent-runtime-core/tool-round-executor.ts`（去双开关、接 scheduler）、`agent-runtime-core.ts`（两处调用去 flag）、`code-execution-tool-service.ts`（caller 传递、删白名单）
- 复用不动：`permission-policy-service.ts`、`pending-interaction-service.ts`、`hooks/*`、`observation.ts`、`runtime-xml-protocol/rendering.ts`、事件结构

## 风险与注意
- **JSON Schema→Zod 翻译量大且影响提示词**：`parameters` 派生结果必须逐工具与现有 `registry.ts` 定义比对（enum/required/additionalProperties/description），差异处允许手填 `parameters` 覆盖。这是工作量与回归风险的主要来源，按组迁移+每组测试。
- **Bash `prepareExecution` 可能被调用两次**（checkPermissions 分类 + call 执行）：纯字符串解析，开销可接受；如需可在 ctx 缓存 plan。
- **MCP 工具动态、无 Zod**：走 `inputJSONSchema` 透传、跳过校验、`isConcurrencySafe=false`。
- **过渡期双查找**：务必保证同名工具不会新旧各注册一份（迁移某组时同步从 Provider 摘除）。

## 验证
1. `npm run typecheck`（`backend-ts`）全绿。
2. `npm run test`（vitest）：现有 `tests/routes/runtime-core-execution.test.ts`、`runtime-core.test.ts` 必须保持通过（回归基线）。
3. 新增单测：`tests/runtime/tool-scheduler.test.ts`（只读批并行/写操作断批/`{result_N}` 依赖分层）、`tool-permissions.test.ts`（tool.deny 优先 / policy ask / hook 升降级 / `allowed_callers` 拦截 code_execution）、`validation.test.ts`（坏参数回结构化错误不进 call）。
4. 每组工具迁移后跑一遍对应已有集成测试；端到端用 `npm run dev` 起服务，跑一轮含 `glob`+`read_file`+`execute_bash` 的对话，确认并行只读、写操作串行、bash 审批仍正常。
5. `npm run smoke:parity` 确认与 Python 端行为一致性未回退。
