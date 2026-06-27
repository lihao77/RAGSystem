/**
 * createRuntime —— SDK 入口（设计稿 §2/§4）。
 *
 * 串联 store/dispatcher/kernel/context/prompt/memory/compression：
 * createRuntime(opts).run(input) → RuntimeSession → Dispatcher(startRun) →
 * AgentKernel.run(挂 context/protocol/tools/hook) → finalize → handle(events + result)。
 *
 * Context 端口 / MessageRefresher / HookRegistry 内置默认实现（SDK 自带）；
 * Protocol（XML/native 解析）由 SDK 按 provider_type 自动选择（createProtocol）；ToolProvider（工具执行）
 * 的重型件，SDK 通过端口消费。memory/compression 在 createRuntime 时按 profile 装配进 context sources。
 */
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { ChatMessage, LlmClient } from "@ragsystem/agent-llm";
import { isAbortError, throwIfAborted } from "@ragsystem/agent-protocol";
import type { ApprovalInteraction, Context, KernelResult, MessageRefresher, PermissionPolicy, RuntimeSession, ToolExecContext, ToolWaitRequest, ToolWaitResult, RuntimeStore } from "./contracts.js";
import type { KernelEvent } from "./contracts.js";
import type { ToolRegistry } from "./tools/registry.js";
import type { Tool } from "./tools/tool.js";
import { KernelContext } from "./kernel-context.js";
import type { KernelContext as KernelContextType } from "./kernel-context.js";
import { AgentKernel } from "./kernel.js";
import { Dispatcher, type DispatcherRunContext } from "./dispatcher.js";
import { SqliteRuntimeStore } from "./store/sqlite-store.js";
import type { AgentProfile, MessageInfo } from "./types.js";
import { AgentContextBuilder, type AgentContextSource, type SessionMetadataPort, type ConversationHistoryPort } from "./context/index.js";
import { RecentMessagesContextSource, EmptyMemoryContextSource, filterHistoryMessages } from "./context/index.js";
import { MemoryIndexContextSource } from "./memory/index.js";
import { buildFullSystemPrompt } from "./prompt/prompt-builder.js";
import type { AgentPromptContext } from "./prompt/types.js";
import { AgentContextCompressionService } from "./compression/context-compression.js";
import { createCompactionHook } from "./compression/compaction-hook.js";
import { createHookRegistry, type HookRegistry } from "./hooks/index.js";
import { createProtocol } from "./protocol/index.js";
import { RuntimeToolProvider } from "./tools/index.js";
import { createToolRegistry } from "./tools/registry.js";
import { estimateTokens } from "./compression/token-estimate.js";
import type { ContextUsageProvider } from "./kernel.js";

export interface CreateRuntimeOptions {
  llm: LlmClient;
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
  /** session 元数据读写端口（memory 前缀指纹缓存 + microcompact 缓存用）。 */
  sessionMetadata?: SessionMetadataPort;
  /** 自定义 context sources（默认 recent_messages + memory_index）。 */
  contextSources?: AgentContextSource[];
  /**
   * microcompact 缓存 TTL（秒）：recent-messages source 据此判断旧 tool 结果的清理视图是否过期。
   * 不注入则用默认（DEFAULT_MICROCOMPACT_TTL_SECONDS=600）。消费端从 systemConfig 算好传入，
   * 与 snapshot 路径同源，避免 run/snapshot 分叉。
   */
  microcompactTtlSeconds?: number;
  /** 审批策略端口（可选；不注入即全部 allow）。 */
  permissionPolicy?: PermissionPolicy;
  /** 审批交互端口（可选；permissionPolicy 返回 ask 时阻塞等待）。 */
  approvalInteraction?: ApprovalInteraction;
  /** 后台任务等待回调（消费端注入；不提供则忽略 suggest_wait 信号）。 */
  waitForToolResult?: (request: ToolWaitRequest, ctx: ToolExecContext) => ToolWaitResult | Promise<ToolWaitResult>;
  /**
   * prompt 上下文（消费端算好注入）：backgroundTasks。
   * tools 由内核从 registry 自动填充（per-run 工具集），消费端无需传 tools。
   * skill / delegation 的可用清单由对应工具自身以 enum + extended_usage 自描述，不再经此注入。
   * 不注入 backgroundTasks 则 run_in_background 参数不被裁剪（与历史行为一致）。
   */
  promptContext?: Omit<AgentPromptContext, "tools">;
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

export function createRuntime(options: CreateRuntimeOptions): { run: (input: RunInput) => RunHandle; close: () => void } {
  const profile = options.profile;
  const storeOpts: import("./store/sqlite-store.js").SqliteStoreOptions = {};
  if (options.dataRoot) { storeOpts.dataRoot = options.dataRoot; }
  const store = options.store ?? new SqliteRuntimeStore(storeOpts);

  const ownsStore = !options.store;
  const dataRoot = options.dataRoot ?? path.join(os.homedir(), ".ragsystem");
  const registry: ToolRegistry = Array.isArray(options.tools)
    ? createToolRegistry({ tools: options.tools })
    : options.tools;

  // default tier 内部自取：provider/modelName 已在 profile.llmTiers.default（投影算死），消费端无需再传。
  const defaultTier = profile.llmTiers.default;
  if (!defaultTier) { throw new Error("AgentProfile.llmTiers.default missing（投影契约违反：default 档必填）"); }

  return {
    run: (input: RunInput): RunHandle => {
      const runId = input.runId ?? randomUUID();
      const rootCallId = input.rootCallId ?? randomUUID();
      const threadKey = input.threadKey ?? "root";
      const sessionId = input.sessionId;
      const parentCallId = input.parentCallId ?? null;

      const historyPort: ConversationHistoryPort = {
        getRecentMessages: (sid, _limit, tk) => store.listMessages(sid, tk ?? "root") as unknown as MessageInfo[],
      };
      const metadataPort = options.sessionMetadata ?? makeNoopSessionMetadata();
      const sources = options.contextSources ?? buildDefaultSources(historyPort, metadataPort, profile, dataRoot);
      const contextBuilder = new AgentContextBuilder(sources, options.microcompactTtlSeconds !== undefined ? { microcompactTtlSeconds: options.microcompactTtlSeconds } : {});

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

      const { protocol, toolInstructionMode } = createProtocol({
        provider: defaultTier.provider,
        llm: options.llm,
        events: dispatcher,
        getTools: () => registry.listDefinitions(),
      });
      const context: Context = makeContextPort(contextBuilder, profile, toolInstructionMode, {
        tools: registry.listDefinitions(),
        backgroundTasks: options.promptContext?.backgroundTasks,
      });
      const refresher: MessageRefresher = { refresh: async () => [] };

      const compression = new AgentContextCompressionService({ store, llm: options.llm, profile });
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
      // permission：作为 tool.gate handler 注册（不可移除的安全网）。policy.evaluate → deny/allow/ask；
      // ask 经 approvalInteraction 阻塞 resolve。无 permissionPolicy 则不注册（放行，由工具自判路径准入）。
      if (options.permissionPolicy) {
        registerPermissionGateHandler(hooks, options.permissionPolicy, options.approvalInteraction ?? null);
      }
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
          const tokens = estimateTokens(message.content ?? "");
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
      const kernel = new AgentKernel({ context, protocol, tools, events: dispatcher, refresher, hooks, contextUsage });
      const resultPromise = runKernel(kernel, session, dispatcher);
      return { events: dispatcher.events, result: resultPromise, runId };
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
    const finalMessage: ChatMessage | null = result.content ? { role: "assistant", content: result.content } : null;
    dispatcher.finalize("completed", finalMessage);
    return result;
  } catch (error) {
    const aborted = session.signal?.aborted;
    dispatcher.finalize(aborted ? "interrupted" : "failed", null);
    throw error;
  }
}

function buildDefaultSources(historyPort: ConversationHistoryPort, metadataPort: SessionMetadataPort, profile: AgentProfile, dataRoot?: string): AgentContextSource[] {
  const recent = new RecentMessagesContextSource(historyPort);
  const memoryEnabled = profile.memory.allowedScopes.length > 0 || profile.memory.writeScopes.length > 0 || profile.memory.archiveScopes.length > 0;
  const memOpts: import("./memory/memory-index-source.js").MemoryIndexContextSourceOptions = {};
  if (dataRoot) { memOpts.dataRoot = dataRoot; }
  const memory = memoryEnabled ? new MemoryIndexContextSource(metadataPort, profile.memory, profile.agentName, memOpts) : new EmptyMemoryContextSource();
  // 顺序：memory 在前——它写 stablePrefixFingerprint，recent 在后读它做 microcompact 缓存判定。
  // 输出顺序也正确：memory prefix（system 段）在历史消息之前。
  return [memory, recent];
}

/**
 * permission tool.gate handler：把 permissionPolicy/approvalInteraction 编排成一个 tool.gate handler。
 * 端口原 runToolApproval 的逻辑（迁出 executor）：policy.evaluate → deny/allow/ask；ask 经 approval 阻塞 resolve。
 * 作为不可移除的安全网注册（deny 在 deny>allow 聚合下永远压过消费方 rogue allow）。
 */
function registerPermissionGateHandler(
  hooks: HookRegistry,
  policy: PermissionPolicy,
  approval: ApprovalInteraction | null,
): void {
  hooks.on("tool.gate", async (input) => {
    let decision;
    try {
      decision = policy.evaluate({
        toolName: input.toolName,
        arguments: input.arguments,
        riskLevel: input.riskLevel,
        ...(input.forceAsk ? { forceAsk: input.forceAsk } : {}),
        ...(input.approvalExempt ? { approvalExempt: input.approvalExempt } : {}),
        ...(input.approvedExternalPaths.length ? { approvedExternalPaths: input.approvedExternalPaths } : {}),
        ctx: input.ctx,
      });
    } catch (error) {
      if (isAbortError(error) || input.ctx.signal?.aborted) { throw error; }
      return { decision: "deny" as const, reason: `审批策略异常: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (decision.action === "deny") {
      return { decision: "deny", reason: decision.reason };
    }
    if (decision.action === "allow") {
      return { decision: "allow", ...(decision.approvedExternalPaths?.length ? { approvedPaths: decision.approvedExternalPaths } : {}) };
    }
    // ask：阻塞等用户审批
    if (!approval) {
      return { decision: "deny", reason: `工具 ${input.toolName} 需要审批，但当前上下文不支持审批` };
    }
    throwIfAborted(input.ctx.signal, "Agent run aborted");
    let resolution;
    try {
      resolution = await approval.waitForApproval({
        toolName: input.toolName,
        arguments: input.arguments,
        reason: decision.reason,
        riskLevel: decision.riskLevel,
        description: decision.description,
        ...(decision.approvedExternalPaths?.length ? { approvedExternalPaths: decision.approvedExternalPaths } : {}),
        ...(decision.permissionMode ? { permissionMode: decision.permissionMode } : {}),
        ...(decision.reasonCodes?.length ? { reasonCodes: decision.reasonCodes } : {}),
        ...(decision.secondaryReasons?.length ? { secondaryReasons: decision.secondaryReasons } : {}),
        ctx: input.ctx,
      });
    } catch (error) {
      if (isAbortError(error) || input.ctx.signal?.aborted) { throw error; }
      return { decision: "deny", reason: `审批流程异常: ${error instanceof Error ? error.message : String(error)}` };
    }
    if (!resolution.approved) {
      return { decision: "deny", reason: `工具 ${input.toolName} 执行已被拒绝：${resolution.reason}` };
    }
    return { decision: "allow", ...(decision.approvedExternalPaths?.length ? { approvedPaths: decision.approvedExternalPaths } : {}) };
  });
}

function makeNoopSessionMetadata(): SessionMetadataPort {
  const meta = new Map<string, Record<string, unknown>>();
  return {
    getSession: (sessionId) => ({ metadata: meta.get(sessionId) ?? {} }),
    updateSessionMetadata: (sessionId, patch) => {
      const next = { ...(meta.get(sessionId) ?? {}), ...patch };
      meta.set(sessionId, next);
      return next;
    },
  };
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
