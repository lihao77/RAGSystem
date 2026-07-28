/**
 * createRuntime —— SDK 入口（设计稿 §2/§4）。
 *
 * 串联 store/dispatcher/kernel/context/prompt/memory/compression：
 * createRuntime(opts).run(input) → RuntimeSession → Dispatcher(startRun) →
 * AgentKernel.run(挂 context/protocol/tools/hook) → finalize → handle(events + result)。
 *
 * Context 端口 / MessageRefresher / HookRegistry 内置默认实现（SDK 自带）；
 * Protocol（XML/native 解析）由 SDK 按 provider_type 自动选择（createProtocol）；ToolProvider（工具执行）
 * 的重型件，SDK 通过端口消费。conversation 由 backend 组装（memory + recent）经 RunInput.conversation 注入，SDK 不内置 context 组装。
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, LlmRequest } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import { isAbortError, throwIfAborted } from "./abort.js";
import type { Context, EventSink, KernelResult, MessageRefresher, RuntimeSession, ToolExecContext, ToolWaitRequest, ToolWaitResult } from "./contracts.js";
import type { KernelEvent } from "./contracts.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { Tool } from "./tools/tool.js";
import { KernelContext } from "./kernel-context.js";
import { getDefaultLlmClient } from "./llm-client.js";
import type { KernelContext as KernelContextType } from "./kernel-context.js";
import { AgentKernel } from "./kernel.js";
import { Dispatcher } from "./dispatcher.js";
import type { AgentProfile } from "./types.js";
import { buildFullSystemPrompt } from "./prompt/prompt-builder.js";
import type { AgentPromptContext } from "./prompt/types.js";
import type { RuntimeToolDefinition } from "./prompt/tool-types.js";
import { resolveContextBudget } from "./llm-params/budget.js";
import { createHookRegistry, type HookRegistry } from "./hooks/index.js";
import { createProtocol } from "./llm-protocol/index.js";
import { RuntimeToolProvider } from "./tools/index.js";
import { createToolRegistry } from "./tools/registry.js";
import { estimateTokens } from "./compression/token-estimate.js";
import type { ContextUsageProvider } from "./kernel.js";

export interface CreateRuntimeOptions {
  profile: AgentProfile;
  /**
   * 工具注册表或工具实例数组。
   * - ToolRegistry：消费端已组装好的注册表（含静态+动态源）。
   * - Tool[]：简单场景传实例数组，内部用 createToolRegistry 包装。
   */
  tools: ToolRegistry | Tool[];
  /** 数据根目录；默认 ~/.ragsystem。 */
  dataRoot?: string;
  /** 后台任务等待回调（消费端注入；不提供则忽略 suggest_wait 信号）。 */
  waitForToolResult?: (request: ToolWaitRequest, ctx: ToolExecContext) => ToolWaitResult | Promise<ToolWaitResult>;
  /**
   * 委托执行指令发送（消费端注入，可选）：注入 ToolExecContext.emitDelegateCall，供消费端构造的委托壳 Tool.call
   * 在 gate 通过后发 delegate_call 驱动宿主执行。SDK 内核不调用，仅透传到工具执行上下文。
   */
  emitDelegateCall?: (input: { toolCallId: string; toolName: string; arguments: Record<string, unknown> }) => void;
  /**
   * 工具执行上下文的消费端切片：承载 run 内稳定、但内核无法自行推导的字段
   * （workspaceRoot / currentAgentName 等）。
   * 内核权威字段（sessionId/runId/taskId/requestId/parentCallId/toolCallId/round/order/roundIndex）
   * 在构造 toolContext 时后置覆盖，execContext 不得误传这些。
   */
  execContext?: Partial<ToolExecContext>;
  /**
   * 消费端 hook 注册回调（可选）。每 run 新建 registry、挂好 compaction 后调用本回调，
   * 消费端在传入的 registry 上注册 tool.before（deny/改入参）、tool.after（改结果）、
   * round.before（注入上下文）等 handler。用回调而非 registry 实例——避免 compaction 跨 run 重复注册。
   * 不传则每 run 仅 compaction。
   */
  hooks?: (registry: HookRegistry) => void;
  /**
   * 消息增量补充端口(可选):内核循环每轮开头调(refresh 在 round.before/buildMessages 之前),
   * 返回的消息 append 进工作副本。用于 run 进行中注入新落库的 user 消息(followup 等)。
   * 接口在 SDK,实现在消费端持 store(符合纯计算内核:SDK 不读 store)。
   * 不传则不补充(默认空,preview 不受影响)。
   */
  refresher?: MessageRefresher;
}

export interface RunInput {
  sessionId: string;
  task: string;
  runId?: string;
  rootCallId?: string;
  threadKey?: string;
 parentCallId?: string;
 signal?: AbortSignal;
  /** run 起始会话快照（backend 组装：memory + recent + microcompact + 压缩视图 + 图片注入）。SDK 仅靠此快照 + 工作副本推进，纯计算不落库。 */
  conversation: ChatMessage[];
}

export interface RunHandle {
  events: AsyncIterable<KernelEvent>;
  result: Promise<KernelResult>;
  runId: string;
}

/** preview 入口：组"模型收到的请求"不调 LLM，供调试快照等只读场景。 */
export interface PreviewInput {
  sessionId: string;
  threadKey?: string | null;
  /** 会话快照（backend 组装：memory + recent + 压缩视图）。preview 用它组 LLM request，不读 store。 */
  conversation: ChatMessage[];
}

/** preview 结果：模型真实收到的请求 + system prompt + token 用量 + 可见工具。 */
export interface PreviewResult {
  /** 模型真实收到的 LLM 请求（messages 协议渲染 + tools + model/provider/参数），与 run 第一轮同源。 */
  request: LlmRequest;
  /** 完整 system prompt（请求首条 system message 内容）。 */
  systemPrompt: string;
  tokenStats: {
    systemPromptTokens: number;
    historyTokens: number;
    totalTokens: number;
  };
  /** 本 runtime 可见的工具定义。 */
  toolDefinitions: RuntimeToolDefinition[];
}

/** preview 协议用的空事件槽：buildRequest 不发事件，run 在闭包内另建 events=dispatcher 的 protocol。 */
const NOOP_EVENT_SINK: EventSink = { emit: () => undefined };

export function createRuntime(options: CreateRuntimeOptions): { run: (input: RunInput) => RunHandle; preview: (input: PreviewInput) => PreviewResult; close: () => void } {
  const profile = options.profile;
  const dataRoot = options.dataRoot ?? path.join(os.homedir(), ".ragsystem");
  const registry: ToolRegistry = Array.isArray(options.tools)
    ? createToolRegistry({ tools: options.tools })
    : options.tools;

  // default tier 可缺：preview 不调 LLM、不需 tier；run 在闭包内守卫 default 必填（调 LLM 必须有 tier）。
  const defaultTier = profile.llmTiers.default;
  // LLM 客户端 SDK 内部自建（agent-llm OpenAiCompatibleClient 单例）：消费端不再注入，
  // SDK 据 profile.llmTiers.default.provider 自带的 ProviderConfig 自行调用。
  const llm = getDefaultLlmClient();

  // 实例级 protocol 装配（run/preview 共用同一 Protocol 类，buildRequest 同源，保证 preview 组出的请求 = run 实际发的）。
  const { protocol: previewProtocol, toolInstructionMode } = createProtocol({
    provider: defaultTier?.provider,
    llm,
    events: NOOP_EVENT_SINK,
    getTools: () => registry.listDefinitions(),
  });
  const contextPort: Context = makeContextPort(profile, toolInstructionMode, {
    tools: registry.listDefinitions(),
  });

  return {
    run: (input: RunInput): RunHandle => {
      if (!defaultTier) { throw new Error("AgentProfile.llmTiers.default missing（run 调 LLM 必须有 default tier）"); }
      const runId = input.runId ?? randomUUID();
      const rootCallId = input.rootCallId ?? randomUUID();
      const threadKey = input.threadKey ?? "root";
      const sessionId = input.sessionId;
      const parentCallId = input.parentCallId ?? null;

    const dispatcher = new Dispatcher();

      // run 的 protocol：events=dispatcher（发事件）；buildRequest 与实例级 preview 协议同源。
      const { protocol } = createProtocol({
        provider: defaultTier.provider,
        llm,
        events: dispatcher,
        getTools: () => registry.listDefinitions(),
      });
      const refresher: MessageRefresher = options.refresher ?? { refresh: async () => [] };

      // per-run registry：每 run 新建;round.before 压缩由 backend handler 注册（A3 压缩外移）。
      const hooks = createHookRegistry();
      options.hooks?.(hooks);

    const session: RuntimeSession = {
      profile,
     provider: defaultTier.provider,
     modelName: defaultTier.modelName,
     conversation: input.conversation,
       sessionId,
       runId,
       taskId: input.task ?? null,
       requestId: null,
       rootCallId,
       threadKey,
       parentCallId,
     };
      if (input.signal) { session.signal = input.signal; }

    const toolContext: ToolExecContext = {
      // 消费端切片（workspaceRoot/currentAgentName 等）在前；内核权威字段在后覆盖。
      ...options.execContext,
      ...(options.emitDelegateCall ? { emitDelegateCall: options.emitDelegateCall } : {}),
      caller: options.execContext?.caller ?? "direct",
      sessionId,
      runId,
      taskId: input.task ?? null,
      requestId: options.execContext?.requestId ?? null,
      // 工具的 parent 是当前 agent 的 root call（委派工具据此把子 agent lineage 挂到本 agent 下）。
      // root run 的 parentCallId 为 null，但工具不属于"父 run"，其父是当前 agent —— 故回退 rootCallId。
      parentCallId: parentCallId ?? rootCallId,
      toolCallId: null,
      round: null,
      order: null,
      roundIndex: null,
    };
      if (input.signal) { toolContext.signal = input.signal; }
      const tools = new RuntimeToolProvider({
        registry,
        toolContext,
        dataRoot,
        events: dispatcher,
        hooks,
        ...(options.waitForToolResult ? { waitForToolResult: options.waitForToolResult } : {}),
      });
      // 上下文用量遥测：system（含稳定 system context）与 history 分桶估算 + 预算（零兜底，纯读 profile）。
      const contextUsage: ContextUsageProvider = (requestMessages) => {
        let systemPromptTokens = 0;
        let historyTokens = 0;
        for (const message of requestMessages) {
          const tokens = estimateTokens(message.content);
          if (message.role === "system") {
            systemPromptTokens += tokens;
          } else {
            historyTokens += tokens;
          }
        }
        // budget = window×0.9 − 实际 systemPromptTokens（动态,本轮 system prompt 含 memory prefix）。
        const budgetTokens = resolveContextBudget(profile.llmTiers, systemPromptTokens, profile.behavior.budget);
        return {
          systemPromptTokens,
          historyTokens,
          totalTokens: systemPromptTokens + historyTokens,
          budgetTokens,
          compressing: false,
        };
      };
      const kernel = new AgentKernel({ context: contextPort, protocol, tools, events: dispatcher, refresher, hooks, contextUsage });
      const resultPromise = runKernel(kernel, session, dispatcher);
      return { events: dispatcher.events, result: resultPromise, runId };
    },
    preview: (input: PreviewInput): PreviewResult => {
      const promptContext = { tools: registry.listDefinitions() };
      // conversation 由 backend 组装注入（memory + recent + 压缩视图）；preview 仅组 LLM request（与 run 第一轮同源），不读 store、不组 context。
      const systemPrompt = buildFullSystemPrompt(profile, promptContext, toolInstructionMode);
      const prefix: ChatMessage[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
      const requestMessages: ChatMessage[] = [...prefix, ...input.conversation];
      const session = {
        profile,
        provider: defaultTier?.provider,
        modelName: defaultTier?.modelName,
        conversation: input.conversation,
        sessionId: input.sessionId,
        runId: "preview",
        taskId: null,
        requestId: null,
        rootCallId: "preview",
        threadKey: input.threadKey ?? "root",
        parentCallId: null,
      } as RuntimeSession;
      const ctx = { session, requestMessages } as unknown as KernelContextType;
      const request = previewProtocol.buildRequest(ctx);
      let systemPromptTokens = 0;
      let historyTokens = 0;
      for (const message of request.messages) {
        const tokens = estimateTokens(extractText(message.content));
        if (message.role === "system") {
          systemPromptTokens += tokens;
        } else {
          historyTokens += tokens;
        }
      }
      return {
        request,
        systemPrompt,
        tokenStats: { systemPromptTokens, historyTokens, totalTokens: systemPromptTokens + historyTokens },
        toolDefinitions: registry.listDefinitions(),
      };
    },
    close: () => {
      // SDK 收窄为纯计算内核（B2：删 store），无底层资源需释放；close 留空保持 createRuntime 返回形状。
    },
  };
}

async function runKernel(kernel: AgentKernel, session: RuntimeSession, dispatcher: Dispatcher): Promise<KernelResult> {
  try {
    const result = await kernel.run(session);
    return result;
  } finally {
    // 落库已外移 backend（event-persister）；SDK 只 close 事件队列，让消费端 for await 退出。
    // 终态收口（最终 message + run_steps + updateRunStatus）由 backend 在 await handle.result 后
    // 据 status（content / aborted / error）用 persister.finalize 合一事务完成。
    dispatcher.close();
  }
}

function makeContextPort(profile: AgentProfile, mode: "xml" | "native", promptContext: AgentPromptContext = {}): Context {
  return {
    buildMessages: (ctx: KernelContextType): ChatMessage[] => {
      const systemPrompt = buildFullSystemPrompt(profile, promptContext, mode);
      // conversation 由 backend 组装注入（RuntimeSession.conversation）；循环中工作副本累积 assistant/observation + 后台通知（round.before 推入）+ 压缩替换（replaceAll）。SDK 不再读 store。
      const prefix = systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : [];
      return [...prefix, ...ctx.messages];
    },
  };
}
