/**
 * createRuntime —— SDK 入口（设计稿 §2/§4）。
 *
 * 串联 store/dispatcher/kernel/context/prompt/memory/compression：
 * createRuntime(opts).run(input) → RuntimeSession → Dispatcher(startRun) →
 * AgentKernel.run(挂 context/protocol/tools/hook) → finalize → handle(events + result)。
 *
 * Context 端口 / MessageRefresher / HookRegistry 内置默认实现（SDK 自带）；
 * Protocol（XML/native 解析）由 SDK 按 provider_type 自动选择（createProtocol）；ToolProvider（工具执行）
 * 的重型件，SDK 通过端口消费。领域 context source（如 memory）由消费端经 extraContextSources 注入，SDK 不内置。
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, LlmRequest } from "@ragsystem/agent-llm";
import { extractText } from "@ragsystem/agent-llm";
import { isAbortError, throwIfAborted } from "@ragsystem/agent-protocol";
import type { Context, EventSink, KernelResult, MessageRefresher, RuntimeSession, ToolExecContext, ToolWaitRequest, ToolWaitResult, RuntimeStore } from "./contracts.js";
import type { KernelEvent } from "./contracts.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { Tool } from "./tools/tool.js";
import { KernelContext } from "./kernel-context.js";
import { getDefaultLlmClient } from "./llm-client.js";
import type { KernelContext as KernelContextType } from "./kernel-context.js";
import { AgentKernel } from "./kernel.js";
import { Dispatcher, type DispatcherRunContext } from "./dispatcher.js";
import { SqliteRuntimeStore } from "./store/sqlite-store.js";
import type { AgentProfile, MessageInfo } from "./types.js";
import { AgentContextBuilder, type AgentContext, type AgentContextSource, type ConversationHistoryPort } from "./context/index.js";
import { RecentMessagesContextSource, filterHistoryMessages } from "./context/index.js";
import { buildFullSystemPrompt } from "./prompt/prompt-builder.js";
import type { AgentPromptContext } from "./prompt/types.js";
import type { RuntimeToolDefinition } from "./prompt/tool-types.js";
import { AgentContextCompressionService } from "./compression/context-compression.js";
import { createCompactionHook } from "./compression/compaction-hook.js";
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
  /** 自定义 store（默认 SqliteRuntimeStore）。 */
  store?: RuntimeStore;
  /**
   * 业务 context sources（在默认 recent_messages 之前追加）。memory 等领域 source 由消费端
   * 经此注入，SDK 不内置 memory（领域无关）。顺序：extra 在前——它写 stablePrefixFingerprint，
   * recent 在后读它做 microcompact 缓存判定。
   */
  extraContextSources?: AgentContextSource[];
  /** 自定义 context sources（完全替换默认；高级用法。不传则用 extraContextSources + 默认 recent）。 */
  contextSources?: AgentContextSource[];
  /**
   * microcompact 缓存 TTL（秒）：recent-messages source 据此判断旧 tool 结果的清理视图是否过期。
   * 不注入则用默认（DEFAULT_MICROCOMPACT_TTL_SECONDS=600）。消费端从 systemConfig 算好传入，
   * 与 snapshot 路径同源，避免 run/snapshot 分叉。
   */
  microcompactTtlSeconds?: number;
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
}

export interface RunInput {
  sessionId: string;
  task: string;
  runId?: string;
  rootCallId?: string;
  threadKey?: string;
 parentCallId?: string;
 signal?: AbortSignal;
  /** run 入口标识（executionKind）；透传 createRun → runs.entrypoint。 */
  entrypoint?: string;
  /** run 发起用户；透传 createRun → runs.user_id。 */
  userId?: string | null;
  /** run task id；透传给 Dispatcher，落 run_step/message 的 task_id 字段。 */
  taskId?: string | null;
  /** run request id；透传给 Dispatcher，落 run_step/message 的 request_id 字段。 */
  requestId?: string | null;
  /**
   * run 级附加消息元数据：透传给 Dispatcher，合并到最终 assistant 消息 metadata。
   * 消费端用此把 execution_kind / retry_of_seq / retry_of_message_id 打到最终消息上。
   */
  messageMetadata?: Record<string, unknown> | null;
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
  /** 协议渲染后的历史（去掉 system + memory prefix），与 context.rawMessages 一一对应。 */
  renderedHistory: ChatMessage[];
  /** buildContext 产出：rawMessages（历史 MessageInfo，含 seq/metadata）+ metadata.sources（memory snapshot）。 */
  context: AgentContext;
}

/** preview 协议用的空事件槽：buildRequest 不发事件，run 在闭包内另建 events=dispatcher 的 protocol。 */
const NOOP_EVENT_SINK: EventSink = { emit: () => undefined };

export function createRuntime(options: CreateRuntimeOptions): { run: (input: RunInput) => RunHandle; preview: (input: PreviewInput) => PreviewResult; close: () => void } {
  const profile = options.profile;
  const storeOpts: import("./store/sqlite-store.js").SqliteStoreOptions = {};
  if (options.dataRoot) { storeOpts.dataRoot = options.dataRoot; }
  const store = options.store ?? new SqliteRuntimeStore(storeOpts);

  const ownsStore = !options.store;
  const dataRoot = options.dataRoot ?? path.join(os.homedir(), ".ragsystem");
  const registry: ToolRegistry = Array.isArray(options.tools)
    ? createToolRegistry({ tools: options.tools })
    : options.tools;

  // default tier 可缺：preview 不调 LLM、不需 tier；run 在闭包内守卫 default 必填（调 LLM 必须有 tier）。
  const defaultTier = profile.llmTiers.default;
  // LLM 客户端 SDK 内部自建（agent-llm OpenAiCompatibleClient 单例）：消费端不再注入，
  // SDK 据 profile.llmTiers.default.provider 自带的 ProviderConfig 自行调用。
  const llm = getDefaultLlmClient();

  // 实例级上下文装配（run/preview 共用）：builder + context 组 requestMessages；protocol 组 LlmRequest。
  // preview 用 events=noop 的 protocol（buildRequest 不发事件），run 闭包内另建 events=dispatcher 的
  // protocol——两者 buildRequest 同源（同一 Protocol 类），保证 preview 组出的请求 = run 实际发的。
  const historyPort: ConversationHistoryPort = {
    getRecentMessages: (sid, _limit, tk) => store.listMessages(sid, tk ?? "root") as unknown as MessageInfo[],
  };
  const sources = options.contextSources ?? [...(options.extraContextSources ?? []), ...buildDefaultSources(historyPort, defaultTier?.provider.supports_vision === true)];
  const contextBuilder = new AgentContextBuilder(sources, options.microcompactTtlSeconds !== undefined ? { microcompactTtlSeconds: options.microcompactTtlSeconds } : {});
  const { protocol: previewProtocol, toolInstructionMode } = createProtocol({
    provider: defaultTier?.provider,
    llm,
    events: NOOP_EVENT_SINK,
    getTools: () => registry.listDefinitions(),
  });
  const contextPort: Context = makeContextPort(contextBuilder, profile, toolInstructionMode, {
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

    const dispatcherCtx: DispatcherRunContext = {
      sessionId,
      runId,
      threadKey,
      agentName: profile.agentName,
      agentDisplayName: profile.displayName ?? profile.agentName,
      rootCallId,
      parentCallId,
      ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.entrypoint !== undefined ? { executionKind: input.entrypoint } : {}),
      taskSummary: input.task.slice(0, 200),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.messageMetadata ? { messageMetadata: input.messageMetadata } : {}),
    };
    const dispatcher = new Dispatcher(store, dispatcherCtx);
      dispatcher.startRun();

      // run 的 protocol：events=dispatcher（发事件）；buildRequest 与实例级 preview 协议同源。
      const { protocol } = createProtocol({
        provider: defaultTier.provider,
        llm,
        events: dispatcher,
        getTools: () => registry.listDefinitions(),
      });
      const refresher: MessageRefresher = { refresh: async () => [] };

      const compression = new AgentContextCompressionService({ store, llm, profile });
      const budgetTokens = compression.resolveContextBudget();
      const triggerRatio = compression.resolveContextSettings().compressionTriggerRatio;
      // per-run registry：每 run 新建，挂 compaction 后调消费端回调注册其 handler。
      // 用回调（而非长驻 registry 实例）避免 compaction 跨 run 重复注册累积。
      const hooks = createHookRegistry();
      hooks.on("round.before", createCompactionHook({
        recompact: async () => {
          const result = await compression.compressIfNeeded({ sessionId, runId, taskId: null, requestId: null, threadKey, childAgentId: parentCallId });
          return result.status === "success" ? [] : null;
        },
        budgetTokens,
        triggerRatio,
      }));
      options.hooks?.(hooks);

    const session: RuntimeSession = {
      profile,
     provider: defaultTier.provider,
     modelName: defaultTier.modelName,
     conversation: filterHistoryMessages(store.listMessages(sessionId, threadKey)).map(toChatMessage),
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
      requestId: input.requestId ?? null,
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
          const tokens = estimateTokens(extractText(message.content));
          if (message.role === "system") {
            systemPromptTokens += tokens;
          } else {
            historyTokens += tokens;
          }
        }
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
      const threadKey = input.threadKey ?? "root";
      const promptContext = { tools: registry.listDefinitions() };
      // buildContext 一次：conversation（memory prefix + 历史）+ rawMessages（历史 MessageInfo，含 seq/metadata）+
      // memory sources。与 run 的 makeContextPort.buildMessages 同源（buildFullSystemPrompt + builder.buildContext），
      // 只是 preview 直调底层以保留 rawMessages 给调试快照展示元数据。
      const built = contextBuilder.buildContext({ sessionId: input.sessionId, threadKey, microcompact: true });
      const systemPrompt = buildFullSystemPrompt(profile, promptContext, toolInstructionMode);
      const prefix: ChatMessage[] = systemPrompt ? [{ role: "system", content: systemPrompt }] : [];
      const requestMessages: ChatMessage[] = [...prefix, ...built.conversation];
      const session = {
        profile,
        provider: defaultTier?.provider,
        modelName: defaultTier?.modelName,
        conversation: built.conversation,
        sessionId: input.sessionId,
        runId: "preview",
        taskId: null,
        requestId: null,
        rootCallId: "preview",
        threadKey,
        parentCallId: null,
      } as RuntimeSession;
      const ctx = { session, requestMessages } as unknown as KernelContextType;
      const request = previewProtocol.buildRequest(ctx);
      // renderedHistory = request.messages 去掉 systemPrompt + memory prefix，与 context.rawMessages 一一对应。
      const memoryPrefixCount = built.metadata.sources.find((s) => s.name === "memory")?.message_count ?? 0;
      const renderedHistory = request.messages.slice(1 + memoryPrefixCount);
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
        renderedHistory,
        context: built,
      };
    },
    close: () => {
      if (ownsStore) {
        store.close?.();
      }
    },
  };
}

async function runKernel(kernel: AgentKernel, session: RuntimeSession, dispatcher: Dispatcher): Promise<KernelResult> {
  try {
    const result = await kernel.run(session);
    const finalMessage = result.content ? { role: "assistant", content: result.content } : null;
    dispatcher.finalize("completed", finalMessage);
    return result;
  } catch (error) {
    const aborted = session.signal?.aborted;
    dispatcher.finalize(aborted ? "interrupted" : "failed", null);
    throw error;
  }
}

function buildDefaultSources(historyPort: ConversationHistoryPort, supportsVision: boolean): AgentContextSource[] {
  // 仅通用 recent_messages；领域 source（memory 等）由消费端经 extraContextSources 注入（SDK 领域无关）。
  // extraContextSources 在 default 之前装配，保证业务 source 写的 stablePrefixFingerprint 在 recent 读取之前。
  return [new RecentMessagesContextSource(historyPort, supportsVision)];
}

function makeContextPort(builder: AgentContextBuilder, profile: AgentProfile, mode: "xml" | "native", promptContext: AgentPromptContext = {}): Context {
  return {
    buildMessages: (ctx: KernelContextType): ChatMessage[] => {
      const systemPrompt = buildFullSystemPrompt(profile, promptContext, mode);
      // context builder 从 store 读历史（Dispatcher 实时落库 assistant/observation，含当前 run 动态进展；
      // compression 经 insertCompressionMessage 写 store，recompact 后从 store 重读也正确）。
      // 产出含 memory prefix（system 段）+ microcompact 后的历史——直接进 LLM，不再降级为 side effect。
      const built = builder.buildContext({ sessionId: ctx.session.sessionId, threadKey: ctx.session.threadKey, microcompact: true });
      const prefix = systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : [];
      return [...prefix, ...built.conversation];
    },
  };
}

function toChatMessage(m: MessageInfo): ChatMessage {
  const result: ChatMessage = { role: m.role, content: m.content };
  if (m.name) {
    result.name = m.name;
  }
  if (m.toolCallId) {
    result.tool_call_id = m.toolCallId;
  }
  if (m.toolCalls && m.toolCalls.length > 0) {
    result.tool_calls = m.toolCalls.map((call) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }
  return result;
}
