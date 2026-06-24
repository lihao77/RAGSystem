/**
 * createRuntime —— SDK 入口（设计稿 §2/§4）。
 *
 * 串联 store/dispatcher/kernel/context/prompt/memory/compression：
 * createRuntime(opts).run(input) → RuntimeSession → Dispatcher(startRun) →
 * AgentKernel.run(挂 context/protocol/tools/hook) → finalize → handle(events + result)。
 *
 * Context 端口 / MessageRefresher / HookRegistry 内置默认实现（SDK 自带）；
 * Protocol（XML/native 解析）与 ToolProvider（工具执行）由调用方注入——它们是协议/工具特定
 * 的重型件，SDK 通过端口消费。memory/compression 在 createRuntime 时按 profile 装配进 context sources。
 */
import { randomUUID } from "node:crypto";
import type { ChatMessage, LlmClient } from "@ragsystem/agent-llm";
import type { Context, HookPoint, HookRegistry, KernelResult, MessageRefresher, Protocol, RuntimeSession, ToolProvider, RuntimeStore } from "./contracts.js";
import type { KernelEvent } from "./contracts.js";
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
import { AgentContextCompressionService } from "./compression/context-compression.js";
import { createCompactionHook } from "./compression/compaction-hook.js";
import type { ToolInstructionMode } from "./contracts.js";

export interface CreateRuntimeOptions {
  llm: LlmClient;
  provider: AgentProfile["llmTiers"][string]["provider"];
  modelName: string;
  profile: AgentProfile;
  /** 协议端口（XML/native 解析 + 渲染），调用方注入。 */
  protocol: Protocol;
  /** 工具执行端口，调用方注入。 */
  tools: ToolProvider;
  /** 数据根目录；默认 ~/.ragsystem。 */
  dataRoot?: string;
  /** 工具指令形态（决定 prompt 协议说明注入），默认 xml。 */
  toolInstructionMode?: ToolInstructionMode;
  /** 自定义 store（默认 SqliteRuntimeStore）。 */
  store?: RuntimeStore;
  /** session 元数据读写端口（memory 前缀指纹缓存 + microcompact 缓存用）。 */
  sessionMetadata?: SessionMetadataPort;
  /** 自定义 context sources（默认 recent_messages + memory_index）。 */
  contextSources?: AgentContextSource[];
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
}

export interface RunHandle {
  events: AsyncIterable<KernelEvent>;
  result: Promise<KernelResult>;
  runId: string;
}

type HookFn = (ctx: KernelContextType, round?: number) => void | Promise<void>;

export function createRuntime(options: CreateRuntimeOptions): { run: (input: RunInput) => RunHandle; close: () => void } {
  const profile = options.profile;
  const storeOpts: import("./store/sqlite-store.js").SqliteStoreOptions = {};
  if (options.dataRoot) { storeOpts.dataRoot = options.dataRoot; }
  const store = options.store ?? new SqliteRuntimeStore(storeOpts);
  const toolInstructionMode = options.toolInstructionMode ?? "xml";
  const ownsStore = !options.store;

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
      const sources = options.contextSources ?? buildDefaultSources(historyPort, metadataPort, profile, options.dataRoot);
      const contextBuilder = new AgentContextBuilder(sources);

      const dispatcherCtx: DispatcherRunContext = {
        sessionId,
        runId,
        threadKey,
       agentName: profile.agentName,
       parentCallId: parentCallId ?? rootCallId,
      };
      const dispatcher = new Dispatcher(store, dispatcherCtx);
      dispatcher.startRun();

      const context: Context = makeContextPort(contextBuilder, profile, toolInstructionMode);
      const refresher: MessageRefresher = { refresh: async () => [] };

      const compression = new AgentContextCompressionService({ store, llm: options.llm, profile });
      const budgetTokens = compression.resolveContextBudget();
      const triggerRatio = compression.resolveContextSettings().compressionTriggerRatio;
      const compactionHook = createCompactionHook({
        recompact: async () => {
          const result = await compression.compressIfNeeded({ sessionId, runId, taskId: null, requestId: null, threadKey, childAgentId: parentCallId });
          return result.status === "success" ? [] : null;
        },
        budgetTokens,
        triggerRatio,
      });
      const hooks = makeHookRegistry({ beforeModel: [compactionHook] });

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

      const kernel = new AgentKernel({ context, protocol: options.protocol, tools: options.tools, events: dispatcher, refresher, hooks });
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

function makeContextPort(builder: AgentContextBuilder, profile: AgentProfile, mode: ToolInstructionMode): Context {
  return {
    buildMessages: (ctx: KernelContextType): ChatMessage[] => {
      const systemPrompt = buildFullSystemPrompt(profile, {}, mode);
      const built = builder.buildContext({ sessionId: ctx.session.sessionId, threadKey: ctx.session.threadKey, microcompact: true });
      const prefix = systemPrompt ? [{ role: "system" as const, content: systemPrompt }] : [];
      return [...prefix, ...built.conversation];
    },
  };
}

function makeHookRegistry(initial: Partial<Record<HookPoint, HookFn[]>>): HookRegistry {
  const registry: Record<HookPoint, HookFn[]> = { beforeModel: [...(initial.beforeModel ?? [])], afterModel: [...(initial.afterModel ?? [])] };
  return {
    invoke: async (point, ctx, round) => {
      for (const fn of registry[point]) {
        await fn(ctx, round);
      }
    },
    register: (point, fn) => {
      registry[point].push(fn);
    },
  };
}

function toChatMessage(m: MessageInfo): ChatMessage {
  return { role: m.role, content: m.content };
}
