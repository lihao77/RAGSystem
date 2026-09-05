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
import type { AsyncTerminalSalvage } from "./async-event-persister.js";
import { selectLostObservations } from "./lost-observations.js";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { MessageInfo, SessionIdentity } from "../../../contracts/session/session.js";
import type { BackendContextSourceFactory } from "../../../plugins/backend-plugin.js";
import type { MessageContentPart } from "@ragsystem/agent-protocol";
import { partsToPlainText } from "@ragsystem/agent-protocol";
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
import { resolveResumeBoundaryMessageId, resolveResumeToolResults, resolveRunStartRound } from "./run-round.js";
import { terminalReason } from "./terminal-reason.js";
import type { ExecutionEnvironmentCapability } from "../../../contracts/execution/execution-environment.js";
import { describeShellEnvironment } from "../../../contracts/execution/shell-detection.js";
import type { StreamSnapshotRegistry } from "../execution/status-tracker.js";

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
  /** run 控制面注册表：流式快照取像器的 per-run 注册/注销（重连/切会话恢复用）；缺席则快照能力关闭。 */
  streamSnapshots?: StreamSnapshotRegistry;
  /** 消费端 hook 注册回调（可选）；透传给 createRuntime，让 backend 注册 tool.before/after、round.before 等 handler。 */
  hooks?: (registry: HookRegistry) => void;
  /** backend 压缩服务（run 内 round.before 触发 + /compact 共用）；A3 压缩外移。 */
  compressionService?: AgentCompressionService;
  sessionFiles?: SessionFileLookupPort | null;
  executionEnvironment?: ExecutionEnvironmentCapability | null;
  /** 插件贡献的前置对话 source 工厂（上下文组装时实例化，产物排在 history 之前）。 */
  contextSourceFactories?: readonly BackendContextSourceFactory[];
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
  // 口径对齐 kernel 的 context_usage 事件（仅 cached/creation 非零才上报）：会话命中率
  // 的分子分母必须来自同一调用集合——不上报缓存字段的 provider 既不进分子也不进分母，
  // 否则中途换模型会被无缓存调用稀释命中率，与前端实时面板口径不一致。
  if (usage.cachedInputTokens === undefined && usage.cacheCreationInputTokens === undefined) return;
  // 缓存 token 本身就是输入 token：分母下限收敛到分子，实测有网关轮次只报缓存明细
  // 而缺顶层 input 总量（解析层已兜底，这里再挡一道外部直传的 usage）。
  const deltaInput = Math.max(usage.inputTokens, deltaCached + deltaCreation);
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
      shellEnvironment: describeShellEnvironment(deps.executionEnvironment.deploymentKind),
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
    ...(profile.llmTiers.default ? {
      providerKey: profile.llmTiers.default.provider.key ?? profile.llmTiers.default.provider.name,
      model: profile.llmTiers.default.modelName,
    } : {}),
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
  // 中断/失败 salvage 累加器：跟踪当前轮已流出的思考与正文（post-XML-parse 干净增量）。
  // 换轮（model_request）清零；reasoning_complete 到达即固化快照并视为完整。
  const partialRound: { round: number; reasoning: string; reasoningComplete: boolean; content: string } = {
    round: 0,
    reasoning: "",
    reasoningComplete: false,
    content: "",
  };
  const trackPartialRound = (event: KernelEvent): void => {
    if (event.type === "model_request") {
      partialRound.round = event.round;
      partialRound.reasoning = "";
      partialRound.reasoningComplete = false;
      partialRound.content = "";
      return;
    }
    if (event.type === "intent_complete") {
      // 本轮思考与正文均已随 durable 检查点毕业（reasoning_complete 先行封口、
      // intent_complete 带全文、assistant_intermediate 行已落库）：清空在飞累加。
      // 工具执行窗口内的重连快照不再携带已毕业文本（否则前端会投出幻影新轮），
      // 中断 salvage 也不再重复打捞已持久化的整轮内容。
      partialRound.reasoning = "";
      partialRound.reasoningComplete = false;
      partialRound.content = "";
      return;
    }
    if (event.type === "reasoning_delta") {
      partialRound.reasoning += event.content;
      return;
    }
    if (event.type === "reasoning_complete") {
      partialRound.reasoning = event.content;
      partialRound.reasoningComplete = true;
      return;
    }
    if (event.type === "output_delta") {
      partialRound.content += event.content;
    }
  };
  const terminalSalvage = (): AsyncTerminalSalvage | null => {
    const hasReasoning = partialRound.reasoning.trim().length > 0;
    const hasContent = partialRound.content.trim().length > 0;
    if (!hasReasoning && !hasContent) return null;
    return {
      ...(hasReasoning ? { reasoning: partialRound.reasoning, reasoningComplete: partialRound.reasoningComplete } : {}),
      ...(hasContent ? { content: partialRound.content } : {}),
      round: partialRound.round,
    };
  };
  // run 控制面取像：在 journal 串行流内读 partialRound 并发一帧全量快照（ephemeral）。
  // 必须在 journal 任务内读值——帧的流内位置即覆盖点：之前的 delta 已含于快照，
  // 之后的 delta 继续追加，无需帧序号。重连/切会话恢复由 status-tracker 注册表触发。
  const streamLineagePayload = (): { lineage?: { parent_call_id: string } } =>
    wireCtx.parentCallId ? { lineage: { parent_call_id: wireCtx.parentCallId } } : {};
  const emitStreamSnapshot = (): Promise<void> => journal.submit(async () => {
    const reasoning = partialRound.reasoning;
    const content = partialRound.content;
    if (!reasoning.trim() && !content.trim()) return;
    try {
      await deps.eventPublisher.publishEphemeralEnvelope({
        type: "stream_output",
        session_id: wireCtx.sessionId,
        run_id: wireCtx.runId,
        call_id: wireCtx.rootCallId,
        agent_id: wireCtx.agentId,
        ...(wireCtx.boundaryMessageId ? { boundary_message_id: wireCtx.boundaryMessageId } : {}),
        payload: {
          phase: "snapshot",
          round: partialRound.round,
          reasoning,
          reasoning_complete: partialRound.reasoningComplete,
          content,
          ...streamLineagePayload(),
        },
      });
    } catch {
      // best-effort 帧：发布失败绝不进入 journal 失败闩——一次取像瞬时报错不能杀死整个 run。
    }
  });
  const unregisterStreamSnapshot = (): void => {
    deps.streamSnapshots?.unregisterStreamSnapshot(input.runId, emitStreamSnapshot);
  };
  const commitKernelEvent = async (event: KernelEvent): Promise<void> => {
    trackPartialRound(event);
    await persister.persist(event);
    // 流式增量帧走 ephemeral（不落 outbox）：必然被 intent/reasoning complete 检查点或
    // 快照帧覆盖。检查点与结构事件保持 durable，重放语义不变。顺序由 journal 串行化保证。
    const ephemeral = event.type === "output_delta" || event.type === "reasoning_delta";
    for (const envelope of translateKernelEvent(event, wireCtx)) {
      if (ephemeral) await deps.eventPublisher.publishEphemeralEnvelope(envelope);
      else await deps.eventPublisher.commitEnvelope(envelope);
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
  // startRun 尘埃落定后才注册取像器：此前的 startRun 抛错/followup 早退不产生
  // 快照需求，也不向注册表泄漏 emitter。之后所有退出路径由 catch/尾部的 finally 收口。
  deps.streamSnapshots?.registerStreamSnapshot(input.runId, emitStreamSnapshot);

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
  // historyPort 组合 ConversationHistoryPort + SessionMetadataPort：recent source 读历史，
  // context source 读取 session metadata 解析运行上下文。
  const historyPort: ConversationHistoryPort & SessionMetadataPort = {
    getRecentMessages: (sid: string, limit: number | undefined, tk: string | null | undefined) =>
      deps.storage.conversation.getRecentMessages(sid, limit ?? HISTORY_SCAN_LIMIT, tk ?? "root"),
    getSession: (sid: string) => sessionMetadata.getSession(sid),
    updateSessionMetadata: (sid: string, patch: Record<string, unknown>) =>
      sessionMetadata.updateSessionMetadata?.(sid, patch) ?? null,
  };
  const { built, contextBuilder, recentSource, cacheTracker } = await buildBackendAgentContext(input.agent, profile, historyPort, {
    dataRoot: deps.dataRoot,
    sessionId: input.sessionId,
    threadKey: input.threadKey,
    sessionFiles: deps.sessionFiles ?? null,
    sessionIdentity: input.sessionIdentity,
    ...(deps.contextSourceFactories ? { frontContextSources: deps.contextSourceFactories } : {}),
    ...(profile.llmTiers.default ? {
      providerIdentity: {
        providerKey: profile.llmTiers.default.provider.key ?? profile.llmTiers.default.provider.name,
        model: profile.llmTiers.default.modelName,
      },
    } : {}),
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
            // 行落库/终局记录与 wire 同步翻转：之后该 run 的行与新 envelope 都归属插嘴段。
            persister.setBoundaryMessageId?.(wireCtx.boundaryMessageId);
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
        // 投递物不再从全量重建视图按索引筛选：conversation/rawMessages 的索引对齐曾因
        // 孤儿补齐插入而错位（并行批次部分落库窗口），把真实 tool 消息误当"新认领的
        // user 消息"追加——同 tool_call_id 重复应答被上游 400。改为对本轮认领/接受的
        // user 行单独跑同一规范投影（projectRows），交付物与首次请求同形、不依赖全量
        // 视图几何，也省去每次投递的全量历史重建。
        const acceptedIds = new Set([...mailboxAcceptedIds, ...accepted]);
        const acceptedRows = newerRaw.filter((message) => message.role === "user" && acceptedIds.has(message.id));
        const delivered = await recentSource.projectRows(acceptedRows, {
          sessionId: sid,
          threadKey: tk,
          cacheAlive: false,
          touch: false,
        });
        // 维持原重建路径的副作用语义：refresh 处于真正发请求的 run 路径，续期 provider cache 活性。
        cacheTracker.touch(sid, tk, Date.now() / 1000);
        await sessionMetadata.flush();
        return createRefreshResult(delivered);
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
      // 熔断:摘要连续失败(摘要模型不可用/输出为空)达上限后,本 run 不再每轮白调摘要 LLM;
      // 阈值未命中/候选不足属正常跳过,不计数。
      let consecutiveCompressionFailures = 0;
      const MAX_CONSECUTIVE_COMPRESSION_FAILURES = 3;
      if (deps.compressionService) {
        hookRegistry.on("round.before", async (hookInput) => {
          if (consecutiveCompressionFailures >= MAX_CONSECUTIVE_COMPRESSION_FAILURES) {
            return;
          }
          // Compression budgets use the stable core prompt. Plugin hooks add their context afterward.
          const mode = resolveToolInstructionMode(profile.llmTiers.default?.provider);
          const systemPromptBase = buildFullSystemPrompt(profile, {
            tools: registry.listDefinitions(),
            ...(baseExecCtx.executionPaths ? { executionPaths: baseExecCtx.executionPaths } : {}),
            ...(baseExecCtx.shellEnvironment ? { shellEnvironment: baseExecCtx.shellEnvironment } : {}),
          }, mode);
          const prediction = inputTokenTracker.predict(hookInput.ctx.messages);
          const systemPromptTokens = Math.max(
            estimateTokens(systemPromptBase),
            prediction?.systemPromptTokens ?? 0,
          );
          // "压缩中"客户端帧：只在真要调摘要 LLM 时发（低于阈值/选段失败不发,避免每轮噪音）;
          // 仅 root 线程——子线程压缩不影响根上下文,会话级呼吸点不该亮。
          const compressionThreadKey = input.threadKey?.trim() || "root";
          const isRootThread = compressionThreadKey === "root";
          const publishCompressionFrame = (detail: Record<string, unknown>, durable = false): void => {
            const envelope: Envelope = {
              type: "state_sync",
              session_id: input.sessionId,
              run_id: input.runId,
              payload: { category: "compression", detail: { ...detail, thread_key: compressionThreadKey } },
            };
            const published = durable
              ? deps.eventPublisher.commitEnvelope(envelope)
              : deps.eventPublisher.publishEphemeralEnvelope(envelope);
            void published.catch(() => undefined);
          };
          let summarizeStarted = false;
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
            ...(isRootThread
              ? {
                  onSummarizeStart: () => {
                    summarizeStarted = true;
                    publishCompressionFrame({ type: "compression_started", run_id: input.runId });
                  },
                }
              : {}),
          });
          if (result.status !== "success") {
            if (result.reason === "summary_unavailable") {
              consecutiveCompressionFailures += 1;
              if (summarizeStarted) {
                publishCompressionFrame({ type: "compression_finished", reason: "summary_unavailable" });
              }
            }
            return;
          }
          if (isRootThread) {
            // durable:摘要卡要进重连回放;started/finished 是瞬态,走 ephemeral。
            publishCompressionFrame({
              type: "compression_summary",
              content: result.summaryMessage ? partsToPlainText(result.summaryMessage.content_parts) : "",
              conversation_scope: "root",
              replaced_message_count: result.replacedMessageCount,
              replaces_up_to_seq: result.replacesUpToSeq,
            }, true);
          }
          consecutiveCompressionFailures = 0;
          cacheTracker.invalidate(input.sessionId, input.threadKey);
          const rebuilt = (await contextBuilder.buildContext({ sessionId: input.sessionId, threadKey: input.threadKey })).conversation;
          await sessionMetadata.flush();
          // 恢复首轮修复:replaceAll 从 store 重读会丢 SDK 工作副本里本轮(通用开始契约重执行)追加但 store 尚未落库的 tool observation。按 tool_call_id 回补配对,避免 assistant tool_use 无 tool_result(Anthropic 400 insufficient tool messages)。
          // 回补前提见 selectLostObservations:tool_use 必须仍在 rebuilt,否则回补的是被压缩替换的历史,会成为无前置 tool_calls 的孤儿(OpenAI 兼容协议 400)。
          const lostObservations = selectLostObservations(hookInput.ctx.messages, rebuilt);
          hookInput.ctx.replaceAll(rebuilt);
          if (lostObservations.length > 0) {
            hookInput.ctx.appendMessages(lostObservations);
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
    // 恢复运行没有 initialMessage：从线程行重建当前 boundary（该 run 已认领的最新
    // 用户行，含插嘴），行盖章与 wire 工具信封的路由不因 suspend→resume 断档。
    if (!wireCtx.boundaryMessageId) {
      const resumeBoundaryId = resolveResumeBoundaryMessageId(contextRawMessages, input.runId);
      if (resumeBoundaryId) {
        wireCtx.boundaryMessageId = resumeBoundaryId;
        persister.setBoundaryMessageId?.(resumeBoundaryId);
      }
    }
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
    try {
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
    // salvage 保留当前轮已流出的思考（thinking part）与半截正文（并入中断原因文本）。
    const terminalError = interrupted ? new Error("session_stopped") : error;
    const finalized = await journal.recover(() => persister.finalize(interrupted ? "interrupted" : "failed", null, terminalError, terminalSalvage()));
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
    } finally {
      unregisterStreamSnapshot();
    }
  }

  if (!result) {
    unregisterStreamSnapshot();
    throw new Error("SDK run completed without a result");
  }
  runtime?.close();

  // completed：终态合一落库（最终 assistant message + Envelope 关联 + updateRunStatus）。
  try {
    const finalized = await journal.submit(() => persister.finalize("completed", {
      content: result.content,
      contentParts: result.contentParts,
      ...(result.providerContinuation ? { providerContinuation: result.providerContinuation } : {}),
      ...(result.reasoning ? { reasoning: result.reasoning } : {}),
    }));
    if (isInteractionRoot) {
      await deps.pendingInteractions.onRootFinalized(
        input.sessionId,
        interactionRootRunId,
        "completed",
        finalized.readyResumeInteractionIds,
      );
    }
  } finally {
    unregisterStreamSnapshot();
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
