import { asString } from "../../../utils/guards.js";
import { randomUUID } from "node:crypto";
/**
 * Runtime 适配器—— 组装投影 + ToolRegistry + createRuntime，跑 SDK 事件循环 + 落库 + 翻译推流 + terminal。
 *
 * SDK 收窄为纯计算内核（B1：Dispatcher 不再落库，只推 KernelEvent 事件流）；本适配器通过
 * deployment-neutral persister 完成 message/run/step/outbox 写入，并翻译 KernelEvent 推送 Envelope。
 */
import { buildFullSystemPrompt, buildTool, createRuntime, createToolRegistry, estimateTokens, prepareTool, RecoverableInterrupt, resolveToolInstructionMode, throwIfAborted, type CreateRuntimeOptions } from "@ragsystem/agent-sdk";
import type { Tool, ToolExecContext, ToolExecutionResult, ToolRegistry, MessageRefreshResult, MessageRefresher, KernelResult, KernelEvent } from "@ragsystem/agent-sdk";
import type { ChatMessage, ThinkingLevel, TokenUsage } from "@ragsystem/agent-llm";
import { translateKernelEvent, type WireTranslationContext } from "./event-translation.js";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { MessageInfo, SessionIdentity } from "../../../contracts/session/session.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import type { ExecutionEventPersister, ExecutionStartDisposition, ExecutionStorage } from "../../../contracts/execution/execution-storage.js";
import type { DelegatedToolDeclarationWire, Envelope } from "../../../contracts/events.js";
import type { AgentExecutionEventPublisher } from "../execution/event-publisher.js";
import type { PermissionPolicyService } from "../../runtime/permission-policy-service.js";
import type { InteractionRequiredNotice, PendingInteractionPort } from "../../../contracts/runtime/pending-interactions.js";
import type { BackendToolsDeps } from "../../../tools/registry.js";
import { createBackendTools } from "../../../tools/registry.js";
import type { BackendToolFactory } from "../../../plugins/backend-plugin.js";
import type { SystemConfigPort } from "../../../contracts/runtime/system-config.js";
import type { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import { projectAgentProfile } from "./projection.js";
import { buildBackendAgentContext, HISTORY_SCAN_LIMIT, type ConversationHistoryPort, type SessionMetadataPort } from "../context/index.js";
import type { AgentCompressionService } from "../context-compression/compression-service.js";
import { readPersistedSessionCacheTotals, RuntimeInputTokenTracker, SESSION_CACHE_TOTALS_METADATA_KEY, type InputTokenTrackerIdentity } from "../context-compression/input-token-tracker.js";
import { registerGateHook } from "./gate-hook.js";
import type { PathAccessPolicy } from "../../../contracts/runtime/path-access-policy.js";
import type { HostToolRegistry } from "../../runtime/host-tool-registry.js";
import type { DelegationPendingService, DelegationResolution } from "../../runtime/delegation-pending-service.js";
import { resolveSessionMetadataPort } from "../context/async-session-metadata-resolver.js";
import type { SessionFileLookupPort } from "../../../contracts/session/session-file-storage.js";
import { resolveResumeToolResults, resolveRunStartRound } from "./run-round.js";
import { terminalReason } from "./terminal-reason.js";
import type { ExecutionEnvironmentCapability } from "../../../contracts/execution/execution-environment.js";

export interface SdkRuntimeAdapterDeps {
  storage: ExecutionStorage;
  /** 工具依赖集合（service + getAgentDelegation；agent/teamName 由 per-run 提供）。 */
  toolsDeps: Omit<BackendToolsDeps, "agent" | "teamName">;
  pluginTools?: BackendToolFactory;
  /** 后台任务等待——从 taskTools 适配。 */
  taskTools: TaskToolService | null;
  eventPublisher: AgentExecutionEventPublisher;
  /** 已加载的全部 provider（投影层解析 tier.provider 引用用）。 */
  providers: ModelProviderConfig[];
  dataRoot: string;
  /** 权限策略服务（SDK 审批编排判定端口用）。 */
  permissionPolicy: PermissionPolicyService;
  pathAccessPolicyFactory: () => PathAccessPolicy;
  /** 审批交互服务（SDK 审批编排阻塞等待端口用）。 */
  pendingInteractions: PendingInteractionPort;
  /** 本租户系统配置（注入插件工具 factory context）。 */
  systemConfig?: SystemConfigPort;
  /** 前端委托工具声明注册表（per-session）；命中前端工具时构造 source=host 转发壳 Tool。 */
  hostToolRegistry: HostToolRegistry;
  /** 委托工具调用等待器（转发壳 Tool.call 注册等待 + 前端 tool_result 回传 resolve）。 */
  delegationPending: DelegationPendingService;
  /** 消费端 hook 注册回调（可选）；透传给 createRuntime，让 backend 注册 tool.before/after、round.before 等 handler。 */
  hooks?: (registry: HookRegistry) => void;
  /** backend 压缩服务（run 内 round.before 触发 + /compact 共用）；A3 压缩外移。 */
  compressionService?: AgentCompressionService;
  sessionFiles?: SessionFileLookupPort | null;
  executionEnvironment?: ExecutionEnvironmentCapability | null;
}

export interface SdkExecuteRunInput {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
  mailboxTargetRunId?: string | null;
  mailboxTargetAgentCallId?: string | null;
  /** Run-engine-owned controller; aborted by the real-time cancel channel (statusTracker.cancelRun). */
  abortController?: AbortController;
  agent: AgentConfig;
  provider: ModelProviderConfig;
  modelName: string;
  task: string;
  threadKey: string;
  /** Durable root lineage inherited unchanged by child and grandchild runs. */
  rootRunId?: string;
  interactionRootCallId?: string;
  lineageParentCallId?: string | null;
  parentCallId?: string | null;
  childAgentId?: string | null;
  ownsRunLease?: boolean;
  /** 父 run id（child delegation run 用；root run 不传 → null）。createRun 落 runs.parent_run_id。 */
  parentRunId?: string | null;
  sessionIdentity: SessionIdentity;
  workspaceRoot?: string | null;
  userId?: string | null;
  executionKind?: string;
  /** 整棵执行树的根任务；child run 从父工具上下文继承。 */
  rootTask?: string;
  signal: AbortSignal;
  /** selectLlm 解析结果（前端选定的 provider+model，整体替换 default 档）。 */
  selectedLlm?: { provider: ModelProviderConfig; modelName: string } | null;
  /** 请求级思考档位（前端 thinking_level）；undefined = 跟随 agent tier 默认档位。 */
  thinkingLevel?: ThinkingLevel;
  /**
   * run 级附加消息元数据：透传给 KernelEventPersister，合并到最终 assistant 消息。
   * 投影点把 execution_kind / retry_of_* 等调用点元数据在这里打好（无值不影响默认）。
   */
  messageMetadata?: Record<string, unknown> | null;
  rootMailboxMessage?: {
    id: string;
    inputType: "user_message" | "agent_message" | "system_notification" | "goal_continuation";
    sourceKind: "user" | "agent" | "system";
    visibleToUser: boolean;
    sentAt: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown>;
  };
  initialMessage?: {
    id: string;
    content: string;
    contentParts: MessageContentPart[];
    metadata?: Record<string, unknown>;
  };
  participantExpectedLastRunId?: string | null;
  initialMailboxMessageId?: string | null;
  followupPolicy?: "queue" | "reject";
  sessionMaintenanceToken?: string;
  initialEnvelopes?: readonly Envelope[];
  onInteractionRequired?: ((notice: InteractionRequiredNotice) => void) | undefined;
  onRunPersisted?: (() => void) | undefined;
  onStartDisposition?: ((disposition: ExecutionStartDisposition) => void) | undefined;
}

export interface SdkExecuteRunResult {
  content: string;
  success: boolean;
  suspended?: boolean;
  followup?: Extract<ExecutionStartDisposition, { kind: "followup" }>;
  rootRunId?: string;
  runId?: string;
  parentRunId?: string | null;
  parentCallId?: string | null;
  toolCallId?: string;
  interactionKind?: "approval" | "user_input";
  /** 本 run 各轮 LLM 调用累计的 token 用量(provider 未返回则为 0)。 */
  tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
  /** 本 run 的工具调用次数分布(toolName → count)。 */
  toolCalls: Record<string, number>;
}

/**
 * 会话级缓存命中累计（_cache_session_totals）：每次 LLM 调用后并入，读-改-写经 per-session
 * 队列串行，避免 root/child 并行 run 交错丢累加。写入失败仅丢一次遥测，不失败 run。
 */
const sessionCacheTotalsQueues = new Map<string, Promise<unknown>>();

function serializeSessionMutation<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const prev = sessionCacheTotalsQueues.get(sessionId) ?? Promise.resolve();
  const next = prev.then(task, task);
  sessionCacheTotalsQueues.set(sessionId, next);
  const cleanup = () => {
    if (sessionCacheTotalsQueues.get(sessionId) === next) sessionCacheTotalsQueues.delete(sessionId);
  };
  // 不用 next.finally(cleanup)：其派生 promise 在 next reject 时同样 reject 且无 handler，
  // 会触发 unhandledRejection（Node 默认终止进程），违背"写入失败仅丢遥测"的意图。
  void next.then(cleanup, cleanup);
  return next;
}

async function accumulateSessionCacheTotals(
  storage: ExecutionStorage,
  sessionId: string,
  usage: TokenUsage,
): Promise<void> {
  const deltaCached = usage.cachedInputTokens ?? 0;
  const deltaCreation = usage.cacheCreationInputTokens ?? 0;
  const deltaInput = usage.inputTokens;
  if (deltaCached <= 0 && deltaCreation <= 0 && deltaInput <= 0) return;
  await serializeSessionMutation(sessionId, async () => {
    const session = await storage.conversation.getSession(sessionId);
    const prev = session ? readPersistedSessionCacheTotals(session.metadata ?? {}) : null;
    await storage.conversation.updateSessionMetadata(sessionId, {
      [SESSION_CACHE_TOTALS_METADATA_KEY]: {
        cached_input_tokens: (prev?.cachedInputTokens ?? 0) + deltaCached,
        cache_creation_input_tokens: (prev?.cacheCreationInputTokens ?? 0) + deltaCreation,
        input_tokens: (prev?.inputTokens ?? 0) + deltaInput,
      },
    });
  });
}

/** Per-run FIFO for every mutation that changes the durable execution timeline. */
export class RuntimeJournal {
  private tail: Promise<void> = Promise.resolve();
  private failure: unknown = null;

  submit<T>(commit: () => T | Promise<T>): Promise<T> {
    const scheduled = this.tail.then(async () => {
      if (this.failure) throw this.failure;
      try {
        return await commit();
      } catch (error) {
        this.failure = error;
        throw error;
      }
    });
    this.tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }

  /** Terminal convergence must still run after a prior journal item failed. */
  recover<T>(commit: () => T | Promise<T>): Promise<T> {
    const scheduled = this.tail.then(commit);
    this.tail = scheduled.then(() => undefined, () => undefined);
    return scheduled;
  }
}

interface DelegateCallInput {
  toolCallId: string;
  toolName: string;
  arguments: Record<string, unknown>;
}

/**
 * SDK 工具执行与 KernelEvent 消费是并行的。Host Tool.call 可能在对应
 * tool_call Envelope 进入 outbox 前就触发 delegate_call，导致 durable seq
 * 反转，重连游标会越过真正驱动前端执行的 delegate_call。
 */
export class OrderedDelegateCallPublisher {
  private readonly readyToolCalls = new Set<string>();
  private readonly pending = new Map<string, DelegateCallInput>();
  private readonly published = new Set<string>();

  constructor(private readonly publish: (input: DelegateCallInput) => void | Promise<void>) {}

  emit(input: DelegateCallInput): void {
    if (this.published.has(input.toolCallId)) return;
    if (this.readyToolCalls.delete(input.toolCallId)) {
      this.published.add(input.toolCallId);
      void Promise.resolve(this.publish(input)).catch(() => undefined);
      return;
    }
    this.pending.set(input.toolCallId, input);
  }

  markToolCallPublished(toolCallId: string): DelegateCallInput | null {
    if (this.published.has(toolCallId)) return null;
    const pending = this.pending.get(toolCallId);
    if (!pending) {
      this.readyToolCalls.add(toolCallId);
      return null;
    }
    this.pending.delete(toolCallId);
    this.published.add(toolCallId);
    return pending;
  }
}

function renderMailboxContent(parts: MessageContentPart[]): string {
  const text = parts.flatMap((part): string[] => {
    if (part.type === "text") return [part.text];
    if (part.type === "command_ref" && part.resolution.kind === "prompt") return [part.resolution.agent_text];
    return [];
  }).join("\n").trim();
  return text || parts.map((part) => `[agent message part:${part.type}]`).join("\n");
}

function renderAgentMailboxMessage(message: {
  message_id: string;
  kind: string;
  content_parts: MessageContentPart[];
  source_agent_call_id: string | null;
}): string {
  const content = renderMailboxContent(message.content_parts);
  const source = message.source_agent_call_id ? ` source_call=${message.source_agent_call_id}` : "";
  return `[agent-message kind=${message.kind} id=${message.message_id}${source}]\n${content}\n[/agent-message]`;
}

/**
 * 用 SDK createRuntime 执行一次 agent run。
 *
 * 生命周期：KernelEventPersister.startRun（createRun）→ createRuntime(opts).run(input) →
 * 消费 handle.events（persister.persist 落库 + 翻译推 outbox）→ await handle.result →
 * persister.finalize（终态合一落库）→ terminal 推终态 envelope。
 */
export async function executeRunWithSdk(
  deps: SdkRuntimeAdapterDeps,
  input: SdkExecuteRunInput,
): Promise<SdkExecuteRunResult> {
  // SaaS loads its durable session policy before synchronous SDK tool gates run.
  await deps.permissionPolicy.prepareSession(input.sessionId);
  const profile = projectAgentProfile({
    agent: input.agent,
    providers: deps.providers,
    ...(input.selectedLlm !== undefined ? { selectedLlm: input.selectedLlm } : {}),
    ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
  });
  const rootRunId = input.rootRunId ?? input.parentRunId ?? input.runId;
  const isRootRun = input.runId === rootRunId && input.parentRunId == null;
  const isInteractionRoot = isRootRun || input.ownsRunLease === true;
  const interactionRootRunId = input.ownsRunLease ? input.runId : rootRunId;
  const interactionRootCallId = input.ownsRunLease
    ? input.rootCallId
    : input.interactionRootCallId ?? input.rootCallId;
  // Session metadata only carries extensible context; Team configuration is an immutable Session snapshot.
  const sessionMetadata = await resolveSessionMetadataPort(
    input.sessionId,
    deps.storage.conversation,
  );

  // per-run 构建工具集合：后端工具 + 前端委托工具（source=host，其 Tool.call 转发宿主执行 + 等回传）。
  const teamName = input.sessionIdentity.teamSnapshot.team_name;
  const pathService = deps.pathAccessPolicyFactory();
  const effectivePermission = deps.permissionPolicy.getEffectivePolicy(input.sessionId);
  pathService.setAllowUnapprovedExternalPaths(
    effectivePermission.mode === "dangerously_skip_permissions" || effectivePermission.skip_all_approvals,
  );
  const hostTools = buildHostDelegateTools(deps.hostToolRegistry.get(input.sessionId), deps.delegationPending);
  let registry: ToolRegistry | null = null;
  const contributedTools = await deps.pluginTools?.({
    tenantId: deps.storage.tenantId,
    teamName,
    agent: input.agent,
    pathAccessPolicy: pathService,
    ...(deps.systemConfig ? { systemConfig: deps.systemConfig } : {}),
    providers: deps.providers,
    // 供宿主按插件构建 pluginEvents（plugin_event 下行帧）；run 内工具可推进度/通知。
    clientEvents: deps.eventPublisher.clientEventPort,
    // 与上下文投影层同源（同一 profile，含运行时 selectedLlm 覆盖）：
    // 视觉主模型无需辅助描述，插件可据此跳过冗余的视觉调用。
    mainModelSupportsVision: profile.llmTiers.default?.provider.supports_vision === true,
    callTool: async (toolName, args, callerCtx) => {
      if (!registry) throw new Error("Tool registry is not initialized");
      const ctx: ToolExecContext = { ...baseExecCtx, ...callerCtx };
      const prepare = prepareTool({ registry }, toolName, args, ctx);
      if (!prepare.ok) return prepare.result;
      return prepare.prepared.tool.call(prepare.prepared.input, ctx);
    },
  }) ?? [];
  const tools: Tool[] = [
    ...createBackendTools({
      ...deps.toolsDeps,
      agent: input.agent,
      ...(teamName ? { teamName } : {}),
      agentConfig: {
        getConfig: (agentName) => input.sessionIdentity.teamSnapshot.agents[agentName] ?? null,
      },
      canMessageParent: Boolean(input.parentRunId && input.childAgentId),
    }),
    ...(Array.isArray(contributedTools) ? contributedTools : [contributedTools]),
    ...hostTools,
  ];
  registry = createToolRegistry({ tools });

  // per-run 工具执行上下文消费端切片：workspaceRoot/currentAgentName 等内核无法自行推导的字段。
  // 经 createRuntime({ execContext }) 注入；内核权威字段（sessionId/runId/...）在 toolContext 构造时后置覆盖。
  // toolCallId/round/order/roundIndex 由 tool-round-executor 在每次调用时覆盖。
  const baseExecCtx: ToolExecContext = {
    tenantId: deps.storage.tenantId,
    sessionId: input.sessionId,
    runId: input.runId,
    rootRunId: interactionRootRunId,
    rootCallId: interactionRootCallId,
    threadKey: input.threadKey,
    currentChildAgentId: input.childAgentId ?? null,
    currentCallId: input.rootCallId,
    parentRunId: input.parentRunId ?? null,
    runParentCallId: input.parentCallId ?? null,
    taskId: input.taskId,
    requestId: input.requestId,
    parentCallId: input.lineageParentCallId ?? input.parentCallId ?? input.rootCallId,
    toolCallId: null,
    round: null,
    order: null,
    roundIndex: null,
    currentAgentName: input.agent.agent_name,
    executionKind: input.executionKind ?? "agent_stream",
    ...(input.onInteractionRequired ? { onInteractionRequired: input.onInteractionRequired } : {}),
    rootTask: input.rootTask ?? input.task,
    userId: input.userId ?? null,
    workspaceRoot: input.workspaceRoot ?? asString(input.agent.custom_params.workspace_root),
    ...(deps.executionEnvironment ? {
      executionPaths: deps.executionEnvironment.paths({
        sessionId: input.sessionId,
        runId: input.runId,
        workspaceRoot: input.workspaceRoot ?? asString(input.agent.custom_params.workspace_root),
      }),
    } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  };

  // 插件工具互调回调走 SDK prepareTool + tool.call；调用方身份由插件写入 context。
  // 后台任务等待回调（task_output 等用）
  const waitForToolResult = deps.taskTools
    ? (request: import("@ragsystem/agent-sdk").ToolWaitRequest, ctx: ToolExecContext) =>
      deps.taskTools!.waitForBackgroundTask({
        taskId: request.backgroundTaskId,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    : undefined;

  const journal = new RuntimeJournal();
  const commitDelegateCall = (sdkInput: DelegateCallInput) => deps.eventPublisher.commitDelegateCall({
      sessionId: input.sessionId,
      runId: input.runId,
      callId: sdkInput.toolCallId,
      agentId: input.agent.agent_name,
      tool: sdkInput.toolName,
      arguments: sdkInput.arguments,
      parentCallId: input.rootCallId,
    });
  const orderedDelegateCalls = new OrderedDelegateCallPublisher((sdkInput) =>
    journal.submit(() => commitDelegateCall(sdkInput)));

  const wireCtx: WireTranslationContext = {
    sessionId: input.sessionId,
    runId: input.runId,
    rootCallId: input.rootCallId,
    requestId: input.requestId,
    agentId: input.agent.agent_name,
    boundaryMessageId: input.initialMessage?.id ?? input.rootMailboxMessage?.id ?? null,
  };
  if (input.lineageParentCallId !== undefined && input.lineageParentCallId !== null) {
    wireCtx.parentCallId = input.lineageParentCallId;
  }
  const persister: ExecutionEventPersister = deps.storage.createEventPersister({
    tenantId: deps.storage.tenantId,
    sessionId: input.sessionId,
    runId: input.runId,
    threadKey: input.threadKey,
    agentName: input.agent.agent_name,
    agentDisplayName: input.agent.display_name ?? input.agent.agent_name,
    rootCallId: input.rootCallId,
    rootRunId: interactionRootRunId,
    taskId: input.taskId,
    ...(input.provider.provider_type ? { providerType: input.provider.provider_type } : {}),
    ...(input.executionKind ? { executionKind: input.executionKind } : {}),
    taskSummary: input.task.slice(0, 200),
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    sessionIdentity: input.sessionIdentity,
    ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
    ...(input.parentCallId !== undefined ? { parentCallId: input.parentCallId } : {}),
    ...(input.lineageParentCallId !== undefined ? { lineageParentCallId: input.lineageParentCallId } : {}),
    ...(input.childAgentId !== undefined ? { childAgentId: input.childAgentId } : {}),
    ...(input.ownsRunLease ? { ownsRunLease: true } : {}),
    ...(input.messageMetadata ? { messageMetadata: input.messageMetadata } : {}),
    ...(input.rootMailboxMessage ? { rootMailboxMessage: input.rootMailboxMessage } : {}),
    ...(input.initialMessage ? {
      initialMessage: {
        sessionId: input.sessionId,
        messageId: input.initialMessage.id,
        role: "user",
        content: input.initialMessage.content,
        contentParts: input.initialMessage.contentParts,
        metadata: input.initialMessage.metadata ?? {},
        threadKey: input.threadKey,
        childAgentId: input.childAgentId ?? null,
      },
    } : {}),
    ...(input.participantExpectedLastRunId !== undefined ? {
      participantExpectedLastRunId: input.participantExpectedLastRunId,
    } : {}),
    ...(input.initialMailboxMessageId ? { initialMailboxMessageId: input.initialMailboxMessageId } : {}),
    ...(input.followupPolicy ? { followupPolicy: input.followupPolicy } : {}),
    ...(input.sessionMaintenanceToken ? { sessionMaintenanceToken: input.sessionMaintenanceToken } : {}),
    ...(input.initialEnvelopes ? { initialEnvelopes: input.initialEnvelopes } : {}),
  });
  const commitKernelEvent = async (event: KernelEvent): Promise<void> => {
    await persister.persist(event);
    for (const envelope of translateKernelEvent(event, wireCtx)) {
      await deps.eventPublisher.commitEnvelope(envelope);
    }
    if (event.type === "tool_call") {
      const delegateCall = orderedDelegateCalls.markToolCallPublished(event.toolCallId);
      if (delegateCall) await commitDelegateCall(delegateCall);
    }
  };
  const startDisposition = await journal.submit(() => persister.startRun());
  if (startDisposition.kind === "followup") {
    input.onStartDisposition?.(startDisposition);
    return { content: "", success: true, followup: startDisposition, tokenUsage: { inputTokens: 0, outputTokens: 0 }, toolCalls: {} };
  }

  let runtime: ReturnType<typeof createRuntime> | null = null;
  let consumeEvents: Promise<void> | null = null;
  let result: KernelResult | null = null;
  const tokenUsage: {
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    cacheCreationInputTokens?: number;
  } = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: Record<string, number> = {};
  try {

  // backend 组装内建 context，插件可通过 hooks 追加上下文。
  // historyPort 组合 ConversationHistoryPort + SessionMetadataPort：recent source 读历史 + microcompact 缓存指纹，
  // context source 读取 session metadata 解析运行上下文。
  const historyPort: ConversationHistoryPort & SessionMetadataPort = {
    getRecentMessages: (sid: string, limit: number | undefined, tk: string | null | undefined) =>
      deps.storage.conversation.getRecentMessages(sid, limit ?? HISTORY_SCAN_LIMIT, tk ?? "root"),
    getProviderContinuation: (sid: string, messageId: string) =>
      deps.storage.providerContinuations.getProviderContinuation(sid, messageId),
    getSession: (sid: string) => sessionMetadata.getSession(sid),
    updateSessionMetadata: (sid: string, patch: Record<string, unknown>) =>
      sessionMetadata.updateSessionMetadata?.(sid, patch) ?? null,
  };
  const { built, contextBuilder, cacheTracker } = await buildBackendAgentContext(input.agent, profile, historyPort, {
    dataRoot: deps.dataRoot,
    sessionId: input.sessionId,
    threadKey: input.threadKey,
    sessionFiles: deps.sessionFiles ?? null,
  });
  await sessionMetadata.flush();
  let conversation = built.conversation;
  let contextRawMessages = built.rawMessages;
  // refresh 水位线:本 run 启动前 store 最后一条消息的 seq;refresh 每轮拉 seq > lastSeq 的新 user 消息(followup 等)。
  let lastSeq = built.rawMessages.reduce(
    (max, m) => (m && typeof m.seq === "number" && m.seq > max ? m.seq : max),
    0,
  );
  const deliveredMailboxMessageIds = new Set<string>();
  for (const message of built.rawMessages) {
    if (message?.metadata?.agent_message === true) deliveredMailboxMessageIds.add(message.id);
  }
  const mailboxConsumerId = `${process.pid}:${input.runId}:${randomUUID()}`;
  const eventCommits = new WeakMap<object, Promise<void>>();
  // Inputs, their durable boundary, and the ACK commit as one journal item.
  // This keeps a follow-up behind every event emitted by the preceding round.
  const refresher: MessageRefresher = {
    refresh: (ctx, round) => journal.submit(async () => {
      const sid = ctx.session.sessionId;
      const tk = ctx.session.threadKey;
      const mailboxAcceptedIds = new Set<string>();
      const refreshStartSeq = lastSeq;
      let mailboxMaxSeq = lastSeq;
      const mailbox = deps.storage.agentMailbox;
      if (mailbox) {
        const claimed = await mailbox.claim({
          sessionId: sid,
          targetRunId: input.mailboxTargetRunId ?? input.runId,
          targetAgentCallId: input.mailboxTargetAgentCallId ?? input.rootCallId,
          targetThreadKey: tk,
          ...(input.childAgentId ? { targetChildAgentId: input.childAgentId } : {}),
          claimId: `${input.runId}:mailbox:${randomUUID()}`,
          consumerId: mailboxConsumerId,
          limit: 100,
        });
        for (const mailboxMessage of claimed) {
          try {
            const isUserMessage = mailboxMessage.input_type === "user_message";
            const renderedContent = isUserMessage
              ? renderMailboxContent(mailboxMessage.content_parts)
              : renderAgentMailboxMessage(mailboxMessage);
            const displayContent = renderMailboxContent(mailboxMessage.content_parts);
            const mailboxMetadata = mailboxMessage.metadata ?? {};
            const isQueuedUserFollowup = isUserMessage
              && typeof mailboxMetadata.run_id === "string"
              && mailboxMetadata.run_id !== input.runId;
            const isContinuationSeed = input.executionKind === "session_followup"
              && input.requestId === `session_followup_${mailboxMessage.message_id}`;
            const isRunInjection = isQueuedUserFollowup && !isContinuationSeed;
            const normalizedUserMetadata = (() => {
              const {
                source: _mailboxSource,
                execution_kind: mailboxExecutionKind,
                round_index: _mailboxRoundIndex,
                ...messageMetadata
              } = mailboxMetadata;
              return {
                ...messageMetadata,
                execution_kind: isRunInjection
                  ? "session_followup"
                  : (isQueuedUserFollowup ? "agent_stream" : (mailboxExecutionKind ?? "agent_stream")),
                run_id: input.runId,
                ...(isRunInjection ? { source: "running_session", round_index: round } : {}),
              };
            })();
            const canonicalMetadata = {
              ...(isUserMessage ? normalizedUserMetadata : mailboxMetadata),
              ...(isUserMessage ? {} : { agent_message: true }),
              agent_message_display_content: displayContent,
              agent_message_direction: mailboxMetadata.direction ?? null,
              agent_message_source_agent_name: mailboxMetadata.source_agent_name ?? null,
              agent_message_source_child_agent_id: mailboxMetadata.source_child_agent_id ?? mailboxMetadata.child_agent_id ?? null,
              agent_message_target_agent_name: mailboxMetadata.target_agent_name ?? null,
              agent_message_target_child_agent_id: mailboxMessage.target_child_agent_id,
              agent_message_target_thread_key: mailboxMessage.target_thread_key,
              mailbox_message_id: mailboxMessage.message_id,
              mailbox_kind: mailboxMessage.kind,
              mailbox_correlation_id: mailboxMessage.correlation_id,
              mailbox_reply_to_message_id: mailboxMessage.reply_to_message_id,
              mailbox_source_run_id: mailboxMessage.source_run_id,
              mailbox_source_agent_call_id: mailboxMessage.source_agent_call_id,
              conversation_scope: mailboxMessage.target_child_agent_id ? "child" : "agent",
              consumed_by_run_id: input.runId,
              visible_to_user: mailboxMessage.visible_to_user,
              sent_at: mailboxMessage.sent_at,
            };
            const envelope = deps.eventPublisher.buildAgentMessage({
              sessionId: sid,
              runId: input.runId,
              callId: input.rootCallId,
              message: { ...mailboxMessage, metadata: canonicalMetadata },
            });
            const committed = await deps.storage.commitRunInput({
              sessionId: sid,
              runId: input.runId,
              message: {
                sessionId: sid,
                messageId: mailboxMessage.message_id,
                role: "user",
                content: renderedContent,
                contentParts: isUserMessage ? mailboxMessage.content_parts : [{ type: "text", text: renderedContent }],
                threadKey: mailboxMessage.target_thread_key,
                childAgentId: mailboxMessage.target_child_agent_id,
                metadata: canonicalMetadata,
              },
              record: deps.eventPublisher.prepareEnvelope(
                envelope,
                `${input.runId}:input:${mailboxMessage.message_id}`,
              ),
              mailboxAck: {
                sessionId: sid,
                messageId: mailboxMessage.message_id,
                claimId: mailboxMessage.claim_id ?? "",
              },
              leaseRootRunId: interactionRootRunId,
            });
            const persisted = committed.message;
            wireCtx.boundaryMessageId = persisted?.id ?? mailboxMessage.message_id;
            const outbox = committed.record?.outbox;
            // The input, boundary, outbox, and ACK are already committed. A
            // live delivery failure leaves the outbox pending for retry and
            // must not turn durable input consumption into a Run failure.
            if (outbox) void deps.eventPublisher.deliver([outbox]).catch(() => undefined);
            mailboxMaxSeq = Math.max(mailboxMaxSeq, persisted?.seq ?? mailboxMessage.seq);
            if (mailboxMessage.input_type === "user_message") {
              const attachmentIds = mailboxMessage.content_parts.flatMap((part) => part.type === "attachment_ref" ? [part.file_id] : []);
              baseExecCtx.attachmentFileIds = [...new Set([...(baseExecCtx.attachmentFileIds ?? []), ...attachmentIds])];
            }
            if (!deliveredMailboxMessageIds.has(mailboxMessage.message_id)) {
              mailboxAcceptedIds.add(mailboxMessage.message_id);
            }
            // Canonical history and the run boundary are already durable. A later
            // provider failure belongs to this run and must not enqueue the same
            // message into a second follow-up run.
            deliveredMailboxMessageIds.add(mailboxMessage.message_id);
          } catch (error) {
            await mailbox.release({
              sessionId: sid,
              messageId: mailboxMessage.message_id,
              claimId: mailboxMessage.claim_id ?? "",
              lastError: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        }
      }
      const createRefreshResult = (messages: ChatMessage[]): MessageRefreshResult => ({ messages });
      try {
        const recent = await deps.storage.conversation.getRecentMessages(sid, HISTORY_SCAN_LIMIT, tk);
        const newerRaw = recent
          .filter((m) => typeof m.seq === "number" && m.seq > refreshStartSeq)
          .sort((a, b) => (a.seq as number) - (b.seq as number));
        const lastMsg = newerRaw.at(-1);
        const accepted = newerRaw
          .filter((message) => message.role === "user" && message.metadata.mailbox_message_id == null)
          .map((message) => message.id);
        if (lastMsg && typeof lastMsg.seq === "number") lastSeq = Math.max(lastSeq, lastMsg.seq);
        lastSeq = Math.max(lastSeq, mailboxMaxSeq);
        if (accepted.length === 0 && mailboxAcceptedIds.size === 0) return createRefreshResult([]);
        // Reuse the canonical history pipeline for follow-ups so command_ref, attachments,
        // and metadata extensions have the exact same Agent projection as the first request.
        const refreshed = await contextBuilder.buildContext({
          sessionId: sid,
          threadKey: tk,
          microcompact: false,
        });
        await sessionMetadata.flush();
        const acceptedIds = new Set([...mailboxAcceptedIds, ...accepted]);
        return createRefreshResult(refreshed.conversation.flatMap((message, index): ChatMessage[] => {
          const raw = refreshed.rawMessages[index];
          return raw?.role === "user" && acceptedIds.has(raw.id) ? [message] : [];
        }));
      } catch (error) {
        throw error;
      }
    }),
  };
  // 性能指标采集:round.after hook 累计各轮 token,事件循环统计工具调用次数(终态随结果返回)。
  const inputTokenTracker = new RuntimeInputTokenTracker();
  const inputTokenIdentity: InputTokenTrackerIdentity = {
    threadKey: input.threadKey,
    agentName: input.agent.agent_name,
    providerKey: input.provider.key ?? input.provider.name ?? input.provider.provider_type,
    modelName: input.modelName,
  };
  inputTokenTracker.restore(
    sessionMetadata.getSession(input.sessionId)?.metadata ?? {},
    inputTokenIdentity,
  );
  const runtimeOpts: CreateRuntimeOptions = {
    profile,
    tools: registry,
    dataRoot: deps.dataRoot,
    execContext: baseExecCtx,
    hooks: (hookRegistry) => {
      registerGateHook(hookRegistry, {
        permissionPolicy: deps.permissionPolicy,
        pendingInteractions: deps.pendingInteractions,
        pathService,
        agentName: input.agent.agent_name,
      });
      // run 内压缩（round.before）：判阈值 → compressIfNeeded → 压缩成功则重组 conversation（重读 store 含压缩视图）→ replaceAll 工作副本。
      if (deps.compressionService) {
        hookRegistry.on("round.before", async (hookInput) => {
          // Compression budgets use the stable core prompt. Plugin hooks add their context afterward.
          const mode = resolveToolInstructionMode(profile.llmTiers.default?.provider);
          const systemPromptBase = buildFullSystemPrompt(profile, {
            tools: registry.listDefinitions(),
            ...(baseExecCtx.executionPaths ? { executionPaths: baseExecCtx.executionPaths } : {}),
          }, mode);
          const prediction = inputTokenTracker.predict(hookInput.ctx.messages);
          const systemPromptTokens = Math.max(
            estimateTokens(systemPromptBase),
            prediction?.systemPromptTokens ?? 0,
          );
          const result = await deps.compressionService!.compressIfNeeded({
            agent: input.agent,
            sessionId: input.sessionId,
            threadKey: input.threadKey,
            runId: input.runId,
            taskId: input.taskId,
            requestId: input.requestId,
            systemPromptTokens,
            ...(prediction ? { providerAdjustedInputTokens: prediction.inputTokens } : {}),
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (result.status === "success") {
            cacheTracker.invalidate(input.sessionId, input.threadKey);
            const rebuilt = (await contextBuilder.buildContext({ sessionId: input.sessionId, threadKey: input.threadKey, microcompact: true })).conversation;
            await sessionMetadata.flush();
            // 恢复首轮修复:replaceAll 从 store 重读会丢 SDK 工作副本里本轮(通用开始契约重执行)追加但 store 尚未落库的 tool observation。按 tool_call_id 回补配对,避免 assistant tool_use 无 tool_result(Anthropic 400 insufficient tool messages)。
            const rebuiltToolCallIds = new Set(rebuilt.filter((m) => m.role === "tool").map((m) => m.tool_call_id).filter((id): id is string => Boolean(id)));
            const lostObservations = hookInput.ctx.messages.filter(
              (m) => m.role === "tool" && typeof m.tool_call_id === "string" && !rebuiltToolCallIds.has(m.tool_call_id),
            );
            hookInput.ctx.replaceAll(rebuilt);
            if (lostObservations.length > 0) {
              hookInput.ctx.appendMessages(lostObservations);
            }
          }
        });
      }
      // 累计每轮 LLM 返回的 token 用量(provider 返回 usage 时累加,用于性能监控)。
      hookRegistry.on("round.after", async (hookInput) => {
        const usage = hookInput.outcome.usage;
        if (usage) {
          // Provider input + output is the exact post-round context baseline. Include the
          // assistant message in the corresponding message-count anchor so the next round
          // does not estimate and add the same output again.
          const observed = inputTokenTracker.observe(
            usage,
            hookInput.contextUsage,
            [...hookInput.ctx.messages, hookInput.outcome.assistantMessage],
          );
          tokenUsage.inputTokens += usage.inputTokens;
          tokenUsage.outputTokens += usage.outputTokens;
          if (usage.cachedInputTokens) {
            tokenUsage.cachedInputTokens = (tokenUsage.cachedInputTokens ?? 0) + usage.cachedInputTokens;
          }
          if (usage.cacheCreationInputTokens) {
            tokenUsage.cacheCreationInputTokens = (tokenUsage.cacheCreationInputTokens ?? 0) + usage.cacheCreationInputTokens;
          }
          // 会话级缓存累计：每次调用后并入 session metadata（同"记录用量"模式，仅覆盖累加键）。
          void accumulateSessionCacheTotals(deps.storage, input.sessionId, usage).catch(() => undefined);
          if (observed) {
            const patch = inputTokenTracker.metadataPatch(inputTokenIdentity);
            if (patch) {
              try {
                await deps.storage.conversation.updateSessionMetadata(input.sessionId, patch);
              } catch {
                // Token feedback is advisory; a metadata write failure must not fail the run.
              }
            }
          }
        }
      });
      deps.hooks?.(hookRegistry);
    },
    ...(waitForToolResult ? { waitForToolResult } : {}),
    emitDelegateCall: (sdkInput) => orderedDelegateCalls.emit(sdkInput),
    refresher,
    onEvent: (event) => {
      const committed = journal.submit(async () => {
        await commitKernelEvent(event);
      });
      void committed.catch(() => undefined);
      eventCommits.set(event, committed);
    },
  };

    input.onStartDisposition?.(startDisposition);
    input.onRunPersisted?.();
    // User/system mailbox messages are claimed by the first round refresher.
    // 必须基于最终实际发送给模型的上下文生成 sandbox allowlist，不能使用落库前的预构建快照。
    baseExecCtx.attachmentFileIds = collectAttachmentFileIds(contextRawMessages);
    const startRound = resolveRunStartRound(contextRawMessages, input.runId);
    const resumeToolResults = resolveResumeToolResults(contextRawMessages, input.runId, startRound);
    runtime = createRuntime(runtimeOpts);
    const handle = runtime.run({
      sessionId: input.sessionId,
      task: input.task,
      runId: input.runId,
      rootCallId: input.rootCallId,
      threadKey: input.threadKey,
      startRound,
      resumeToolResults,
      conversation,
      ...(input.parentCallId !== undefined && input.parentCallId !== null ? { parentCallId: input.parentCallId } : {}),
      signal: input.signal,
    });

    // 事件循环：增量落库（KernelEventPersister）+ 翻译推流（translateKernelEvent → envelope → outbox）。
    consumeEvents = (async () => {
      for await (const event of handle.events) {
        const committed = eventCommits.get(event as object)
          ?? journal.submit(() => commitKernelEvent!(event));
        await committed;
        if (event.type === "tool_call") {
          toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1;
        }
      }
    })();
    const eventConsumption = consumeEvents;
    if (!eventConsumption) throw new Error("SDK event consumer was not started");
    const [kernelResult] = await Promise.all([handle.result, eventConsumption]);
    result = kernelResult;
  } catch (error) {
    await consumeEvents?.catch(() => undefined);
    runtime?.close();
    if (error instanceof RecoverableInterrupt) {
      const finalized = await journal.recover(() => persister.finalize("suspended", null, error));
      if (isInteractionRoot) {
        await deps.pendingInteractions.onRootFinalized(
          input.sessionId,
          interactionRootRunId,
          "suspended",
          finalized.readyResumeInteractionIds,
        );
      }
      if (input.runId !== error.rootRunId) {
        throw error;
      }
      return {
        content: error.message,
        success: false,
        suspended: true,
        rootRunId: error.rootRunId,
        runId: error.runId,
        parentRunId: error.parentRunId,
        parentCallId: error.parentCallId,
        toolCallId: error.toolCallId,
        interactionKind: error.kind,
        tokenUsage,
        toolCalls,
      };
    }
    const interrupted = input.signal.aborted || (error instanceof Error && error.name === "AbortError");
    // 终态合一落库：failed/interrupted 更新 run 状态并补齐本 run 的悬空 tool observation。
    const terminalError = interrupted ? new Error("session_stopped") : error;
    const finalized = await journal.recover(() => persister.finalize(interrupted ? "interrupted" : "failed", null, terminalError));
    if (isInteractionRoot) {
      await deps.pendingInteractions.onRootFinalized(
        input.sessionId,
        interactionRootRunId,
        interrupted ? "interrupted" : "failed",
        finalized.readyResumeInteractionIds,
      );
    }
    const message = terminalReason(interrupted ? "interrupted" : "failed", terminalError);
    return {
      content: message,
      success: false,
      tokenUsage,
      toolCalls,
    };
  }

  if (!result) throw new Error("SDK run completed without a result");
  runtime?.close();

  // completed：终态合一落库（最终 assistant message + Envelope 关联 + updateRunStatus）。
  const finalized = await journal.submit(() => persister.finalize("completed", {
    content: result.content,
    contentParts: result.contentParts,
  }));
  if (isInteractionRoot) {
    await deps.pendingInteractions.onRootFinalized(
      input.sessionId,
      interactionRootRunId,
      "completed",
      finalized.readyResumeInteractionIds,
    );
  }
  return {
    content: result.content,
    success: true,
    tokenUsage,
    toolCalls,
  };
}

function collectAttachmentFileIds(messages: readonly (MessageInfo | null)[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    for (const part of message?.content_parts ?? []) {
      if (part.type === "attachment_ref") ids.add(part.file_id);
    }
  }
  return [...ids];
}


/**
 * 把前端委托工具声明构造为 SDK Tool（委托壳）。委托执行下沉到 Tool.call：
 * gate 通过后 SDK 调此 call——先经 ctx.emitDelegateCall 发 delegate_call 驱动宿主（gate 后才发，审批挡得住），
 * 再等前端 delegate_result 回传 → 转 ToolExecutionResult。
 * delegate_call 走 realtime（不落 outbox），与 tool_call（投影通知，SDK 统一 emit）分离。SDK 内核零委托字样。
 */
function buildHostDelegateTools(
  declarations: DelegatedToolDeclarationWire[],
  delegationPending: DelegationPendingService,
): Tool[] {
  return declarations.map((decl) => buildTool({
    name: decl.name,
    description: decl.description,
    parameters: decl.input_schema,
    ...(decl.risk_level !== undefined ? { riskLevel: decl.risk_level } : {}),
    allowedCallers: ["direct"],
    isReadOnly: () => decl.read_only === true,
    isConcurrencySafe: () => false,
    call: (input, ctx) => {
      const callId = typeof ctx.toolCallId === "string" ? ctx.toolCallId.trim() : "";
      if (!callId) {
        throw new Error(`委托工具 ${decl.name} 缺少有效的 tool_call_id`);
      }
      if (!ctx.emitDelegateCall) {
        throw new Error(`委托工具 ${decl.name} 缺少 emitDelegateCall 注入，无法驱动宿主执行`);
      }
      throwIfAborted(ctx.signal, "Agent run aborted");
      // Register before publishing the instruction. The AG-UI client may
      // execute and resume a local tool before publishDelegateCall returns.
      const pending = delegationPending.wait(callId, ctx.signal ? { signal: ctx.signal } : undefined);
      try {
        ctx.emitDelegateCall({ toolCallId: callId, toolName: decl.name, arguments: input });
      } catch (error) {
        delegationPending.resolve(callId, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return pending.then((resolution) => toHostToolExecutionResult(decl.name, resolution));
    },
  }));
}

/** 前端委托回传 DelegationResolution → ToolExecutionResult。 */
function toHostToolExecutionResult(toolName: string, resolution: DelegationResolution): ToolExecutionResult {
  if (!resolution.ok) {
    return {
      success: false,
      toolName,
      summary: "前端委托执行失败",
      answer: null,
      outputType: "error",
      content: resolution.error ?? "前端委托执行失败",
      metadata: {},
      files: [],
      llmHint: null,
    };
  }
  return {
    success: true,
    toolName,
    summary: "前端委托执行完成",
    answer: null,
    outputType: "text",
    content: resolution.observation ?? "",
    metadata: typeof resolution.elapsedMs === "number" ? { elapsed_ms: resolution.elapsedMs } : {},
    files: [],
    llmHint: null,
  };
}
