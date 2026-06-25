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
import { RecentMessagesContextSource, EmptyMemoryContextSource } from "./context/index.js";
import { MemoryIndexContextSource } from "./memory/index.js";
import { buildFullSystemPrompt } from "./prompt/prompt-builder.js";
import type { AgentPromptContext } from "./prompt/types.js";
import { AgentContextCompressionService } from "./compression/context-compression.js";
import { createCompactionHook } from "./compression/compaction-hook.js";
import { createHookRegistry } from "./hooks/index.js";
import { createProtocol } from "./protocol/index.js";
import { RuntimeToolProvider } from "./tools/index.js";
import { createToolRegistry } from "./tools/registry.js";
import { estimateTokens } from "./compression/token-estimate.js";
import type { ContextUsageProvider } from "./kernel.js";

export interface CreateRuntimeOptions {
  llm: LlmClient;
  provider: AgentProfile["llmTiers"][string]["provider"];
  modelName: string;
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
  /** 审批策略端口（可选；不注入即全部 allow）。 */
  permissionPolicy?: PermissionPolicy;
  /** 审批交互端口（可选；permissionPolicy 返回 ask 时阻塞等待）。 */
  approvalInteraction?: ApprovalInteraction;
  /** 后台任务等待回调（消费端注入；不提供则忽略 suggest_wait 信号）。 */
  waitForToolResult?: (request: ToolWaitRequest, ctx: ToolExecContext) => ToolWaitResult | Promise<ToolWaitResult>;
  /**
   * prompt 上下文（消费端算好注入）：skills/delegatedAgents/backgroundTasks。
   * tools 由内核从 registry 自动填充（per-run 工具集），消费端无需传 tools。
   * 不注入则 system prompt 不含 skills/delegation/background 段（与历史行为一致）。
   */
  promptContext?: Omit<AgentPromptContext, "tools">;
}

export interface RunInput {
  sessionId: string;
  task: string;
  messages?: ChatMessage[];
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
      const contextBuilder = new AgentContextBuilder(sources);

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
        provider: options.provider,
        llm: options.llm,
        events: dispatcher,
        getTools: () => registry.listDefinitions(),
      });
      const context: Context = makeContextPort(contextBuilder, profile, toolInstructionMode, {
        tools: registry.listDefinitions(),
        skills: options.promptContext?.skills,
        delegatedAgents: options.promptContext?.delegatedAgents,
        backgroundTasks: options.promptContext?.backgroundTasks,
      });
      const refresher: MessageRefresher = { refresh: async () => [] };

      const compression = new AgentContextCompressionService({ store, llm: options.llm, profile });
      const budgetTokens = compression.resolveContextBudget();
      const triggerRatio = compression.resolveContextSettings().compressionTriggerRatio;
      const hooks = createHookRegistry();
      hooks.on("round.before", createCompactionHook({
        recompact: async () => {
          const result = await compression.compressIfNeeded({ sessionId, runId, taskId: null, requestId: null, threadKey, childAgentId: parentCallId });
          return result.status === "success" ? [] : null;
        },
        budgetTokens,
        triggerRatio,
      }));

     const session: RuntimeSession = {
       profile,
       provider: options.provider,
       modelName: options.modelName,
       conversation: input.messages ?? store.listMessages(sessionId, threadKey).map(toChatMessage),
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
        sessionId,
        runId,
        taskId: input.task ?? null,
        requestId: null,
        parentCallId,
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
        ...(options.permissionPolicy ? { permissionPolicy: options.permissionPolicy } : {}),
        ...(options.approvalInteraction ? { approvalInteraction: options.approvalInteraction } : {}),
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
  const memory = memoryEnabled ? new MemoryIndexContextSource(metadataPort, profile, memOpts) : new EmptyMemoryContextSource();
  return [recent, memory];
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
      // ctx.messages 是内核工作副本（session.conversation 浅拷贝），含当前用户消息 + 历史 + 历轮 assistant/tool 消息。
      // context builder 从 store 读历史视图（触发 memory prefix / microcompact 等 side effect），
      // 但基础对话以 ctx.messages 为准——store 历史转换可能丢 tool_call_id 等结构化字段。
      builder.buildContext({ sessionId: ctx.session.sessionId, threadKey: ctx.session.threadKey, microcompact: true });
      const prefix = systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : [];
      return [...prefix, ...ctx.messages];
    },
  };
}

function toChatMessage(m: MessageInfo): ChatMessage {
  return { role: m.role, content: m.content };
}
