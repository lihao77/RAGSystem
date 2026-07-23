import { asString } from "../../../utils/guards.js";
/**
 * Runtime 适配器—— 组装投影 + ToolRegistry + createRuntime，跑 SDK 事件循环 + 落库 + 翻译推流 + terminal。
 *
 * SDK 收窄为纯计算内核（B1：Dispatcher 不再落库，只推 KernelEvent 事件流）；本适配器通过
 * deployment-neutral persister 完成 message/run/step/outbox 写入，并翻译 KernelEvent 推送 Envelope。
 */
import { buildFullSystemPrompt, buildTool, createRuntime, createToolRegistry, estimateTokens, prepareTool, resolveToolInstructionMode, type CreateRuntimeOptions } from "@ragsystem/agent-sdk";
import type { Tool, ToolExecContext, ToolExecutionResult, ToolRegistry, MessageRefresher } from "@ragsystem/agent-sdk";
import type { ChatMessage } from "@ragsystem/agent-llm";
import { RecoverableInterrupt, translateKernelEvent, type WireTranslationContext } from "@ragsystem/agent-protocol";
import type { AgentConfig } from "../../../contracts/agent/agent-config.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { ModelProviderConfig } from "../../../contracts/integrations/model-adapter.js";
import type { MemoryConfig } from "../../../contracts/runtime/system-config.js";
import type { ExecutionEventPersister, ExecutionStartDisposition, ExecutionStorage } from "../../../contracts/execution/execution-storage.js";
import type { DelegatedToolDeclarationWire, Envelope } from "../../../contracts/events.js";
import type { AgentExecutionEventPublisher } from "../execution/event-publisher.js";
import type { PermissionPolicyService } from "../../runtime/permission-policy-service.js";
import type { InteractionRequiredNotice, PendingInteractionPort } from "../../../contracts/runtime/pending-interactions.js";
import type { BackendToolsDeps } from "../../../tools/registry.js";
import { createBackendTools } from "../../../tools/registry.js";
import type { CodeExecutionPort } from "../../../contracts/runtime/tool-ports.js";
import type { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import { projectAgentProfile } from "./projection.js";
import { buildBackendAgentContext, HISTORY_SCAN_LIMIT, type ConversationHistoryPort, type SessionMetadataPort } from "../context/index.js";
import type { AgentCompressionService } from "../context-compression/compression-service.js";
import { memoryBaselineKey } from "../memory/index.js";
import { registerGateHook } from "./gate-hook.js";
import type { PathAccessPolicy } from "../../../contracts/runtime/path-access-policy.js";
import type { HostToolRegistry } from "../../runtime/host-tool-registry.js";
import type { DelegationPendingService, DelegationResolution } from "../../runtime/delegation-pending-service.js";
import type { ExecutionMemoryCandidateListPort, MemoryRuntimeBindings } from "../memory/runtime-bindings.js";
import { resolveSessionMetadataPort } from "../context/async-session-metadata-resolver.js";
import type { SessionFollowupQueue } from "../execution/session-followup-queue.js";

export interface SdkRuntimeAdapterDeps {
  storage: ExecutionStorage;
  /** 工具依赖集合（service + getAgentDelegation；agent/teamName 由 per-run 提供）。 */
  toolsDeps: Omit<BackendToolsDeps, "agent" | "teamName">;
  /** CodeExecution service——per-run 注入 callTool 回调用（execute_code 沙箱内工具互调）。 */
  codeExecutionTools: CodeExecutionPort | null;
  /** 后台任务等待——从 taskTools 适配。 */
  taskTools: TaskToolService | null;
  eventPublisher: AgentExecutionEventPublisher;
  /** 已加载的全部 provider（投影层解析 tier.provider 引用用）。 */
  providers: ModelProviderConfig[];
  dataRoot: string;
  /** 每次 run 读取最新 memory 配置。 */
  getMemoryConfig: () => MemoryConfig;
  memoryContextSourceFactory?: MemoryRuntimeBindings["createContextSource"];
  /** 权限策略服务（SDK 审批编排判定端口用）。 */
  permissionPolicy: PermissionPolicyService;
  pathAccessPolicyFactory: () => PathAccessPolicy;
  /** 审批交互服务（SDK 审批编排阻塞等待端口用）。 */
  pendingInteractions: PendingInteractionPort;
  /** 前端委托工具声明注册表（per-session）；命中前端工具时构造 source=host 转发壳 Tool。 */
  hostToolRegistry: HostToolRegistry;
  /** 委托工具调用等待器（转发壳 Tool.call 注册等待 + 前端 tool_result 回传 resolve）。 */
  delegationPending: DelegationPendingService;
  /** 消费端 hook 注册回调（可选）；透传给 createRuntime，让 backend 注册 tool.before/after、round.before 等 handler。 */
  hooks?: (registry: HookRegistry) => void;
  /** backend 压缩服务（run 内 round.before 触发 + /compact 共用）；A3 压缩外移。 */
  compressionService?: AgentCompressionService;
  /** Follow-ups remain here until the active root run starts its next model round. */
  followupQueue: SessionFollowupQueue;
}

export interface SdkExecuteRunInput {
  sessionId: string;
  runId: string;
  taskId: string;
  requestId: string;
  rootCallId: string;
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
  /** 父 run id（child delegation run 用；root run 不传 → null）。createRun 落 runs.parent_run_id。 */
  parentRunId?: string | null;
  sessionMetadata: Record<string, unknown>;
  userId?: string | null;
  executionKind?: string;
  /** 整棵执行树的根任务；child run 从父工具上下文继承。 */
  rootTask?: string;
  signal: AbortSignal;
  /** selectLlm 解析结果（前端选定的 provider+model，整体替换 default 档）。 */
  selectedLlm?: { provider: ModelProviderConfig; modelName: string } | null;
  /**
   * run 级附加消息元数据：透传给 KernelEventPersister，合并到最终 assistant 消息。
   * 投影点把 execution_kind / retry_of_* 等调用点元数据在这里打好（无值不影响默认）。
   */
  messageMetadata?: Record<string, unknown> | null;
  userMessageId?: string;
  initialUserMessageContent?: string;
  initialUserMessageMetadata?: Record<string, unknown>;
  initialEnvelopes?: readonly Envelope[];
  /** Runs after the durable run start and before rebuilding model context. */
  prepareRun?: () => void | Promise<void>;
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
  tokenUsage: { inputTokens: number; outputTokens: number };
  /** 本 run 的工具调用次数分布(toolName → count)。 */
  toolCalls: Record<string, number>;
}

/**
 * Makes queued follow-ups durable at the boundary before a model round.
 * The caller appends the returned messages to the SDK working context.
 */
export async function persistQueuedFollowupsAtRound(
  deps: Pick<SdkRuntimeAdapterDeps, "storage" | "eventPublisher" | "followupQueue">,
  input: {
    sessionId: string;
    threadKey: string;
    runId: string;
    agentName: string;
    round: number;
  },
): Promise<Array<{ message: ChatMessage; seq: number }>> {
  const deferred = deps.followupQueue.drain(input.runId);
  const injected: Array<{ message: ChatMessage; seq: number }> = [];
  const roundIndex = Math.max(0, input.round - 1);
  for (const entry of deferred) {
    const {
      agent: _agent,
      run_id: _runId,
      task_id: _taskId,
      request_id: _requestId,
      execution_kind: _executionKind,
      source: _source,
      round_index: _roundIndex,
      ...baseMetadata
    } = entry.metadata;
    const message = await deps.storage.conversation.addMessage({
      sessionId: input.sessionId,
      role: "user",
      content: entry.displayTask,
      threadKey: input.threadKey,
      metadata: {
        ...baseMetadata,
        agent: input.agentName,
        run_id: input.runId,
        request_id: entry.requestId,
        execution_kind: "session_followup",
        source: "running_session",
        // The message is read before this round, so it belongs after the prior one.
        round_index: roundIndex,
      },
    });
    deps.eventPublisher.publishOutputMessageSaved(input.sessionId, input.runId, {
      message_id: message.id,
      seq: message.seq,
      role: message.role,
      request_id: entry.requestId,
      round_index: roundIndex,
    });
    injected.push({ message: { role: "user", content: message.content ?? "" }, seq: message.seq });
  }
  return injected;
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
  });
  const rootRunId = input.rootRunId ?? input.parentRunId ?? input.runId;
  const isRootRun = input.runId === rootRunId && input.parentRunId == null;
  // session metadata 端口：委托真实会话存储，让 memory 源能读到 team/workspace_root，
  // 解析出 team/agent/workspace scope（否则只 session scope 存活，其余静默丢弃）。
  const sessionMetadata = await resolveSessionMetadataPort(
    input.sessionId,
    deps.storage.conversation,
  );

  // per-run 构建工具集合：后端工具 + 前端委托工具（source=host，其 Tool.call 转发宿主执行 + 等回传）。
  const teamName = asString(input.sessionMetadata.team);
  const pathService = deps.pathAccessPolicyFactory();
  const effectivePermission = deps.permissionPolicy.getEffectivePolicy(input.sessionId);
  pathService.setAllowUnapprovedExternalPaths(
    effectivePermission.mode === "dangerously_skip_permissions" || effectivePermission.skip_all_approvals,
  );
  const hostTools = buildHostDelegateTools(deps.hostToolRegistry.get(input.sessionId), deps.delegationPending);
  // Ensure SaaS user_global skill packages are materialized before tool discovery/self-description.
  await deps.toolsDeps.skillTools?.hydrateUserGlobalPackages?.();
  const tools: Tool[] = [
    ...createBackendTools({
      ...deps.toolsDeps,
      agent: input.agent,
      ...(teamName ? { teamName } : {}),
    }, pathService),
    ...hostTools,
  ];
  const registry: ToolRegistry = createToolRegistry({ tools });

  // per-run 工具执行上下文消费端切片：workspaceRoot/currentAgentName 等内核无法自行推导的字段。
  // 经 createRuntime({ execContext }) 注入；内核权威字段（sessionId/runId/...）在 toolContext 构造时后置覆盖。
  // toolCallId/round/order/roundIndex 由 tool-round-executor 在每次调用时覆盖。
  const baseExecCtx: ToolExecContext = {
    sessionId: input.sessionId,
    runId: input.runId,
    rootRunId,
    rootCallId: input.interactionRootCallId ?? input.rootCallId,
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
    workspaceRoot: asString(input.sessionMetadata.workspace_root) ?? asString(input.agent.custom_params.workspace_root),
    ...(input.signal ? { signal: input.signal } : {}),
  };

  // CodeExecution 工具互调回调：execute_code 沙箱内 call_tool 走 SDK prepareTool + tool.call。
  // caller=code_execution 走 allowedCallers 准入；互调不走审批（execute_code 已是审批过的上下文）。
  if (deps.codeExecutionTools) {
    deps.codeExecutionTools.setToolCaller(async (toolName, args, callerCtx) => {
      const ctx: ToolExecContext = { ...baseExecCtx, ...callerCtx, caller: "code_execution" };
      const prepare = prepareTool({ registry }, toolName, args, ctx);
      if (!prepare.ok) {
        return prepare.result;
      }
      return prepare.prepared.tool.call(prepare.prepared.input, ctx);
    });
  }

  // 后台任务等待回调（task_output 等用）
  const waitForToolResult = deps.taskTools
    ? (request: import("@ragsystem/agent-sdk").ToolWaitRequest, ctx: ToolExecContext) =>
      deps.taskTools!.waitForBackgroundTask({
        taskId: request.backgroundTaskId,
        ...(request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    : undefined;

  // backend 组装 context（memory + recent），产 conversation 注入 SDK（SDK 不再读 store/自组 context）。
  // historyPort 组合 ConversationHistoryPort + SessionMetadataPort：recent source 读历史 + microcompact 缓存指纹，
  // memory source 读 session metadata（team/workspace scope 解析）。
  const historyPort: ConversationHistoryPort & SessionMetadataPort & ExecutionMemoryCandidateListPort = {
    getRecentMessages: (sid: string, limit: number | undefined, tk: string | null | undefined) =>
      deps.storage.conversation.getRecentMessages(sid, limit ?? HISTORY_SCAN_LIMIT, tk ?? "root"),
    getProviderContinuation: (sid: string, messageId: string) =>
      deps.storage.providerContinuations.getProviderContinuation(sid, messageId),
    getSession: (sid: string) => sessionMetadata.getSession(sid),
    updateSessionMetadata: (sid: string, patch: Record<string, unknown>) =>
      sessionMetadata.updateSessionMetadata?.(sid, patch) ?? null,
    listMemoryCandidates: (query) => deps.storage.memoryCandidates.listMemoryCandidates(query),
  };
  const { built, contextBuilder, cacheTracker } = await buildBackendAgentContext(input.agent, profile, historyPort, {
    memoryConfig: deps.getMemoryConfig(),
    dataRoot: deps.dataRoot,
    sessionId: input.sessionId,
    threadKey: input.threadKey,
    ...(deps.memoryContextSourceFactory ? { memoryContextSourceFactory: deps.memoryContextSourceFactory } : {}),
  });
  await sessionMetadata.flush();
  let conversation = built.conversation;
  // refresh 水位线:本 run 启动前 store 最后一条消息的 seq;refresh 每轮拉 seq > lastSeq 的新 user 消息(followup 等)。
  let lastSeq = built.rawMessages.reduce(
    (max, m) => (m && typeof m.seq === "number" && m.seq > max ? m.seq : max),
    0,
  );
  // Per-run refresher: follow-ups first become durable at this round boundary,
  // then enter the SDK working copy. This prevents them from being sequenced
  // between tool calls and tool results of the preceding round.
  const refresher: MessageRefresher = {
    refresh: async (ctx, round) => {
      const sid = ctx.session.sessionId;
      const tk = ctx.session.threadKey;
      const injected = await persistQueuedFollowupsAtRound(deps, {
        sessionId: sid,
        threadKey: tk,
        runId: input.runId,
        agentName: input.agent.agent_name,
        round,
      });
      let newestSeq = lastSeq;
      for (const entry of injected) newestSeq = Math.max(newestSeq, entry.seq);
      const recent = await deps.storage.conversation.getRecentMessages(sid, HISTORY_SCAN_LIMIT, tk);
      const newer = recent
        .filter((m) => typeof m.seq === "number" && m.seq > newestSeq && m.role === "user")
        .sort((a, b) => (a.seq as number) - (b.seq as number));
      const lastMsg = newer.at(-1);
      if (lastMsg && typeof lastMsg.seq === "number") newestSeq = lastMsg.seq;
      lastSeq = newestSeq;
      return [
        ...injected.map((entry) => entry.message),
        ...newer.map((m): ChatMessage => ({ role: "user", content: m.content ?? "" })),
      ];
    },
  };
  // 性能指标采集:round.after hook 累计各轮 token,事件循环统计工具调用次数(终态随结果返回)。
  const tokenUsage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: Record<string, number> = {};
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
          // systemPromptTokens = buildFullSystemPrompt(base+tools) + memory prefix;budget = window×0.9 − 此值。
          const mode = resolveToolInstructionMode(profile.llmTiers.default?.provider);
          const systemPromptBase = buildFullSystemPrompt(profile, { tools: registry.listDefinitions() }, mode);
          const tokenContext = await contextBuilder.buildContext({ sessionId: input.sessionId, threadKey: input.threadKey, microcompact: true }, { touch: false });
          await sessionMetadata.flush();
          const memoryPrefix = tokenContext.conversation
            .filter((m) => m.role === "system")
            .map((m) => (typeof m.content === "string" ? m.content : ""))
            .join("\n");
          const systemPromptTokens = estimateTokens(systemPromptBase) + estimateTokens(memoryPrefix);
          const result = await deps.compressionService!.compressIfNeeded({
            agent: input.agent,
            sessionId: input.sessionId,
            threadKey: input.threadKey,
            runId: input.runId,
            taskId: input.taskId,
            requestId: input.requestId,
            systemPromptTokens,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (result.status === "success") {
            // 压缩已打断 cache(history 重写):让 memory 前缀快照 + provider cache 活性都失效,
            // 下次 buildContext 据 cacheAlive=false 走重建/清理(memory 重读最新 store、microcompact 清理)。
            const baselineKey = memoryBaselineKey(input.threadKey, input.agent.agent_name);
            historyPort.updateSessionMetadata?.(input.sessionId, { memory_prefix_states: { [baselineKey]: null } });
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
      hookRegistry.on("round.after", (hookInput) => {
        const usage = hookInput.outcome.usage;
        if (usage) {
          tokenUsage.inputTokens += usage.inputTokens;
          tokenUsage.outputTokens += usage.outputTokens;
        }
      });
      deps.hooks?.(hookRegistry);
    },
    ...(waitForToolResult ? { waitForToolResult } : {}),
    emitDelegateCall: (sdkInput) => deps.eventPublisher.publishDelegateCall({
      sessionId: input.sessionId,
      runId: input.runId,
      callId: sdkInput.toolCallId,
      agentId: input.agent.agent_name,
      tool: sdkInput.toolName,
      arguments: sdkInput.arguments,
      parentCallId: input.rootCallId,
    }),
    refresher,
  };

  // 翻译上下文（agent-protocol.translateKernelEvent 纯函数用）：root call + lineage。
  const wireCtx: WireTranslationContext = {
    sessionId: input.sessionId,
    runId: input.runId,
    rootCallId: input.rootCallId,
    requestId: input.requestId,
    agentId: input.agent.agent_name,
    agentDisplayName: input.agent.display_name || input.agent.agent_name,
  };
  if (input.lineageParentCallId !== undefined && input.lineageParentCallId !== null) {
    wireCtx.parentCallId = input.lineageParentCallId;
  }

  // KernelEvent 落库（B1：从 SDK Dispatcher 迁回 backend）：createRun + 增量事件落库 + 终态合一全在此。
  const persister: ExecutionEventPersister = deps.storage.createEventPersister({
      tenantId: deps.storage.tenantId,
      sessionId: input.sessionId,
      runId: input.runId,
      threadKey: input.threadKey,
      agentName: input.agent.agent_name,
      agentDisplayName: input.agent.display_name ?? input.agent.agent_name,
      rootCallId: input.rootCallId,
      rootRunId,
      taskId: input.taskId,
      ...(input.provider.provider_type ? { providerType: input.provider.provider_type } : {}),
      ...(input.executionKind ? { executionKind: input.executionKind } : {}),
      taskSummary: input.task.slice(0, 200),
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.userId !== undefined ? { userId: input.userId } : {}),
      ...(input.parentRunId !== undefined ? { parentRunId: input.parentRunId } : {}),
      ...(input.parentCallId !== undefined ? { parentCallId: input.parentCallId } : {}),
      ...(input.childAgentId !== undefined ? { childAgentId: input.childAgentId } : {}),
      ...(input.messageMetadata ? { messageMetadata: input.messageMetadata } : {}),
      ...(input.userMessageId && input.initialUserMessageMetadata ? {
        initialUserMessage: {
          id: input.userMessageId,
          content: input.initialUserMessageContent ?? input.task,
          metadata: {
            ...(input.initialUserMessageMetadata ?? {}),
            agent: input.agent.agent_name,
            run_id: input.runId,
            task_id: input.taskId,
            request_id: input.requestId,
            execution_kind: input.executionKind ?? "agent_stream",
          },
        },
      } : {}),
      ...(input.initialEnvelopes ? { initialEnvelopes: input.initialEnvelopes } : {}),
  });
  const startDisposition = await persister.startRun();
  if (startDisposition.kind === "followup") {
    if (!input.initialUserMessageMetadata) {
      throw new Error("deferred followup requires an initial user message");
    }
    deps.followupQueue.enqueue({
      activeRunId: startDisposition.activeRunId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      displayTask: input.initialUserMessageContent ?? input.task,
      modelTask: input.task,
      metadata: input.initialUserMessageMetadata,
      userId: input.userId ?? null,
      agent: input.agent,
      provider: input.provider,
      modelName: input.modelName,
      selectedLlm: input.selectedLlm ?? null,
    });
    input.onStartDisposition?.(startDisposition);
    return { content: "", success: true, followup: startDisposition, tokenUsage: { inputTokens: 0, outputTokens: 0 }, toolCalls: {} };
  }
  try {
    await input.prepareRun?.();
  } catch (error) {
    await persister.finalize("failed", null, error);
    throw error;
  }
  input.onStartDisposition?.(startDisposition);
  input.onRunPersisted?.();
  if ((input.userMessageId && input.initialUserMessageMetadata) || input.prepareRun) {
    // startRun atomically persists the initial user message. Rebuild after that
    // commit so the first model request sees the same durable history that
    // subsequent rounds and retries read.
    const startedContext = await contextBuilder.buildContext({
      sessionId: input.sessionId,
      threadKey: input.threadKey,
      microcompact: true,
    });
    await sessionMetadata.flush();
    conversation = startedContext.conversation;
    lastSeq = startedContext.rawMessages.reduce(
      (max, message) => message && typeof message.seq === "number" && message.seq > max ? message.seq : max,
      lastSeq,
    );
  }
  const runtime = createRuntime(runtimeOpts);
  const handle = runtime.run({
    sessionId: input.sessionId,
    task: input.task,
    runId: input.runId,
    rootCallId: input.rootCallId,
    threadKey: input.threadKey,
    conversation,
    ...(input.parentCallId !== undefined && input.parentCallId !== null ? { parentCallId: input.parentCallId } : {}),
    signal: input.signal,
  });

  // 事件循环：增量落库（KernelEventPersister）+ 翻译推流（translateKernelEvent → envelope → outbox）。
  const consumeEvents = (async () => {
    for await (const event of handle.events) {
      if (event.type === "tool_call") {
        toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1;
      }
      await persister.persist(event);
      for (const envelope of translateKernelEvent(event, wireCtx)) {
        deps.eventPublisher.publishEnvelope(envelope);
      }
    }
  })();

  let result;
  try {
    result = await handle.result;
  } catch (error) {
    await consumeEvents.catch(() => undefined);
    if (error instanceof RecoverableInterrupt) {
      const finalized = await persister.finalize("suspended", null, error);
      if (isRootRun) {
        await deps.pendingInteractions.onRootFinalized(
          input.sessionId,
          rootRunId,
          "suspended",
          finalized.readyResumeInteractionIds,
        );
      }
      runtime.close();
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
    runtime.close();
    const interrupted = input.signal.aborted;
    // 终态合一落库：failed/interrupted 更新 run 状态；interrupted 补悬空 tool observation。
    const finalized = await persister.finalize(interrupted ? "interrupted" : "failed", null, error);
    if (isRootRun) {
      await deps.pendingInteractions.onRootFinalized(
        input.sessionId,
        rootRunId,
        interrupted ? "interrupted" : "failed",
        finalized.readyResumeInteractionIds,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return { content: message, success: false, tokenUsage, toolCalls };
  }

  await consumeEvents;
  runtime.close();

  // completed：终态合一落库（最终 assistant message + Envelope 关联 + updateRunStatus）。
  const finalized = await persister.finalize("completed", { content: result.content });
  if (isRootRun) {
    await deps.pendingInteractions.onRootFinalized(
      input.sessionId,
      rootRunId,
      "completed",
      finalized.readyResumeInteractionIds,
    );
  }
  return { content: result.content, success: true, tokenUsage, toolCalls };
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
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    call: (input, ctx) => {
      const callId = ctx.toolCallId ?? "";
      if (!ctx.emitDelegateCall) {
        throw new Error(`委托工具 ${decl.name} 缺少 emitDelegateCall 注入，无法驱动宿主执行`);
      }
      ctx.emitDelegateCall({ toolCallId: callId, toolName: decl.name, arguments: input });
      return delegationPending
        .wait(callId, ctx.signal ? { signal: ctx.signal } : undefined)
        .then((resolution) => toHostToolExecutionResult(decl.name, resolution));
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
      artifacts: [],
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
    artifacts: [],
    llmHint: null,
  };
}
