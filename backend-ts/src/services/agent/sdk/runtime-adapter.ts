/**
 * Runtime 适配器—— 组装投影 + ToolRegistry + 共享 SDK store +
 * createRuntime，跑 SDK 事件循环 + 翻译 + terminal。
 *
 * SDK 内核 + Dispatcher 独占 run/message/run_step 落库（SDK 自带 SqliteRuntimeStore 指向同一 ragsystem.db）；
 * 本适配器只做：组装 createRuntime 入参、消费 KernelEvent 翻译成 Envelope 推 outbox（无 DB 落库，
 * 避免 SDK 与 backend-ts 双写 message/run_step）、terminal 补 run:end/final step + 终态 envelope
 *（final assistant 消息由 SDK Dispatcher.finalize 已写，此处只查库取其 id/seq 供 message_saved）。
 */
import { buildTool, createRuntime, createToolRegistry, prepareTool, type CreateRuntimeOptions, type SqliteRuntimeStore } from "@ragsystem/agent-sdk";
import type { Tool, ToolExecContext, ToolExecutionResult, ToolRegistry } from "@ragsystem/agent-sdk";
import { translateKernelEvent, type WireTranslationContext } from "@ragsystem/agent-protocol";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import type { MessageInfo } from "../../../contracts/session.js";
import type { DelegatedToolDeclarationWire, Envelope } from "../../../contracts/events.js";
import type { AgentExecutionEventPublisher } from "../execution/event-publisher.js";
import type { DurableClientEventPublisher, RecordedClientEvent } from "../../runtime/event-outbox/client-event-publisher.js";
import type { PermissionPolicyService } from "../../runtime/permission-policy-service.js";
import type { PendingInteractionService } from "../../runtime/pending-interaction-service.js";
import type { BackendToolsDeps } from "../../../tools/registry.js";
import { createBackendTools } from "../../../tools/registry.js";
import type { CodeExecutionToolService } from "../../../tools/CodeExecutionTool/CodeExecution.js";
import type { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import { projectAgentProfile } from "./projection.js";
import { AgentContextBuilder, HISTORY_SCAN_LIMIT, RecentMessagesContextSource, type ConversationHistoryPort, type SessionMetadataPort } from "../context/index.js";
import type { AgentCompressionService } from "../context-compression/compression-service.js";
import { MemoryIndexContextSource, isMemoryEnabled } from "../memory/index.js";
import { registerGateHook } from "./gate-hook.js";
import { PathApprovalService } from "../../../services/runtime/path-service.js";
import type { HostToolRegistry } from "../../runtime/host-tool-registry.js";
import type { DelegationPendingService, DelegationResolution } from "../../runtime/delegation-pending-service.js";

export interface SdkRuntimeAdapterDeps {
  conversationStore: ConversationStore;
  /** SDK 共享 store（指向同一 ragsystem.db；createRuntime 复用，container close 时关）。 */
  sdkStore: SqliteRuntimeStore;
  /** 工具依赖集合（service + getAgentDelegation；agent/teamName 由 per-run 提供）。 */
  toolsDeps: Omit<BackendToolsDeps, "agent" | "teamName">;
  /** CodeExecution service——per-run 注入 callTool 回调用（execute_code 沙箱内工具互调）。 */
  codeExecutionTools: CodeExecutionToolService | null;
  /** 后台任务等待——从 taskTools 适配。 */
  taskTools: TaskToolService | null;
  eventPublisher: AgentExecutionEventPublisher;
  clientEvents: DurableClientEventPublisher;
  /** 已加载的全部 provider（投影层解析 tier.provider 引用用）。 */
  providers: ModelProviderConfig[];
  dataRoot: string;
  /** 权限策略服务（SDK 审批编排判定端口用）。 */
  permissionPolicy: PermissionPolicyService;
  /** 审批交互服务（SDK 审批编排阻塞等待端口用）。 */
  pendingInteractions: PendingInteractionService;
  /** 前端委托工具声明注册表（per-session）；命中前端工具时构造 source=host 转发壳 Tool。 */
  hostToolRegistry: HostToolRegistry;
  /** 委托工具调用等待器（转发壳 Tool.call 注册等待 + 前端 tool_result 回传 resolve）。 */
  delegationPending: DelegationPendingService;
  /** 消费端 hook 注册回调（可选）；透传给 createRuntime，让 backend 注册 tool.before/after、round.before 等 handler。 */
  hooks?: (registry: HookRegistry) => void;
  /** microcompact 缓存 TTL（秒）；透传 createRuntime，与 snapshot 路径同源（systemConfig 单一来源）。 */
  microcompactTtlSeconds?: number;
  /** backend 压缩服务（run 内 round.before 触发 + /compact 共用）；A3 压缩外移。 */
  compressionService?: AgentCompressionService;
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
  parentCallId?: string | null;
  childAgentId?: string | null;
  sessionMetadata: Record<string, unknown>;
  userId?: string | null;
  executionKind?: string;
  signal: AbortSignal;
  /** selectLlm 解析结果（前端选定的 provider+model，整体替换 default 档）。 */
  selectedLlm?: { provider: ModelProviderConfig; modelName: string } | null;
  /**
   * run 级附加消息元数据：透传给 SDK Dispatcher，合并到最终 assistant 消息。
   * 投影点把 execution_kind / retry_of_* 等调用点元数据在这里打好（无值不影响默认）。
   */
  messageMetadata?: Record<string, unknown> | null;
}

export interface SdkExecuteRunResult {
  content: string;
  success: boolean;
  /** 本 run 各轮 LLM 调用累计的 token 用量(provider 未返回则为 0)。 */
  tokenUsage: { inputTokens: number; outputTokens: number };
  /** 本 run 的工具调用次数分布(toolName → count)。 */
  toolCalls: Record<string, number>;
}

/**
 * 用 SDK createRuntime 执行一次 agent run。
 *
 * 生命周期：createRuntime(opts).run(input) → 消费 handle.events（翻译推 outbox）→
 * await handle.result（SDK Dispatcher.finalize 已落最终消息 + updateRunStatus）→ terminal 补步/envelope。
 */
export async function executeRunWithSdk(
  deps: SdkRuntimeAdapterDeps,
  input: SdkExecuteRunInput,
): Promise<SdkExecuteRunResult> {
  const profile = projectAgentProfile({
    agent: input.agent,
    providers: deps.providers,
    ...(input.selectedLlm !== undefined ? { selectedLlm: input.selectedLlm } : {}),
  });
  // session metadata 端口：委托真实 ConversationStore，让 memory 源能读到 team/workspace_root，
  // 解析出 team/agent/workspace scope（否则只 session scope 存活，其余静默丢弃）。
  const sessionMetadata: SessionMetadataPort = {
    getSession: (sessionId: string) => {
      const session = deps.conversationStore.getSession(sessionId);
      return session ? { metadata: session.metadata ?? {} } : null;
    },
    updateSessionMetadata: (sessionId: string, patch: Record<string, unknown>) =>
      deps.conversationStore.updateSessionMetadata(sessionId, patch),
  };

  // per-run 构建工具集合：后端工具 + 前端委托工具（source=host，其 Tool.call 转发宿主执行 + 等回传）。
  const teamName = asString(input.sessionMetadata.team);
  const pathService = new PathApprovalService();
  const hostTools = buildHostDelegateTools(deps.hostToolRegistry.get(input.sessionId), deps.delegationPending);
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
    taskId: input.taskId,
    requestId: input.requestId,
    parentCallId: input.parentCallId ?? input.rootCallId,
    toolCallId: null,
    round: null,
    order: null,
    roundIndex: null,
    currentAgentName: input.agent.agent_name,
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
  const historyPort: ConversationHistoryPort & SessionMetadataPort = {
    getRecentMessages: (sid: string, limit: number | undefined, tk: string | null | undefined) =>
      deps.conversationStore.getRecentMessages(sid, limit ?? HISTORY_SCAN_LIMIT, tk ?? "root"),
    getSession: (sid: string) => sessionMetadata.getSession(sid),
    updateSessionMetadata: (sid: string, patch: Record<string, unknown>) =>
      sessionMetadata.updateSessionMetadata?.(sid, patch) ?? null,
  };
  const memorySources = isMemoryEnabled(input.agent.memory)
    ? [new MemoryIndexContextSource(historyPort, input.agent.memory, input.agent.agent_name, { dataRoot: deps.dataRoot })]
    : [];
  const recentSource = new RecentMessagesContextSource(historyPort, profile.llmTiers.default?.provider.supports_vision === true);
  const contextBuilder = new AgentContextBuilder(
    [...memorySources, recentSource],
    deps.microcompactTtlSeconds !== undefined ? { microcompactTtlSeconds: deps.microcompactTtlSeconds } : {},
  );
  const built = contextBuilder.buildContext({ sessionId: input.sessionId, threadKey: input.threadKey, microcompact: true });
  const conversation = built.conversation;
  // 性能指标采集:round.after hook 累计各轮 token,事件循环统计工具调用次数(终态随结果返回)。
  const tokenUsage = { inputTokens: 0, outputTokens: 0 };
  const toolCalls: Record<string, number> = {};
  const runtimeOpts: CreateRuntimeOptions = {
    profile,
    tools: registry,
    dataRoot: deps.dataRoot,
    store: deps.sdkStore,
    execContext: baseExecCtx,
    hooks: (registry) => {
      registerGateHook(registry, {
        permissionPolicy: deps.permissionPolicy,
        pendingInteractions: deps.pendingInteractions,
        pathService,
        agentName: input.agent.agent_name,
      });
      // run 内压缩（round.before）：判阈值 → compressIfNeeded → 压缩成功则重组 conversation（重读 store 含压缩视图）→ replaceAll 工作副本。
      // compressIfNeeded 内部判 below_threshold 快速 skipped（未到阈值不调 LLM）；阈值触发才摘要 + 写 compression 消息。
      if (deps.compressionService) {
        registry.on("round.before", async (hookInput) => {
          const result = await deps.compressionService!.compressIfNeeded({
            agent: input.agent,
            sessionId: input.sessionId,
            threadKey: input.threadKey,
            runId: input.runId,
            taskId: input.taskId,
            requestId: input.requestId,
            ...(input.signal ? { signal: input.signal } : {}),
          });
          if (result.status === "success") {
            const rebuilt = contextBuilder.buildContext({ sessionId: input.sessionId, threadKey: input.threadKey, microcompact: true }).conversation;
            hookInput.ctx.replaceAll(rebuilt);
          }
        });
      }
      // 累计每轮 LLM 返回的 token 用量(provider 返回 usage 时累加,用于性能监控)。
      registry.on("round.after", (hookInput) => {
        const usage = hookInput.outcome.usage;
        if (usage) {
          tokenUsage.inputTokens += usage.inputTokens;
          tokenUsage.outputTokens += usage.outputTokens;
        }
      });
      deps.hooks?.(registry);
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
  if (input.parentCallId !== undefined && input.parentCallId !== null) {
    wireCtx.parentCallId = input.parentCallId;
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
    ...(input.executionKind !== undefined ? { entrypoint: input.executionKind } : {}),
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    taskId: input.taskId,
    requestId: input.requestId,
    ...(input.messageMetadata ? { messageMetadata: input.messageMetadata } : {}),
  });

  // 事件循环：翻译 KernelEvent → Envelope[]（agent-protocol 纯函数），逐条推 outbox（SDK Dispatcher 已落库，此处只推流）。
  const consumeEvents = (async () => {
    for await (const event of handle.events) {
      if (event.type === "tool_call") {
        toolCalls[event.toolName] = (toolCalls[event.toolName] ?? 0) + 1;
      }
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
    runtime.close();
    const interrupted = input.signal.aborted;
    recordTerminal(deps, input, interrupted ? "interrupted" : "failed", null, error);
    const message = error instanceof Error ? error.message : String(error);
    return { content: message, success: false, tokenUsage, toolCalls };
  }

  await consumeEvents;
  runtime.close();

  // completed：SDK Dispatcher.finalize 已落最终 assistant 消息 + updateRunStatus。
  // 查库取该消息 id/seq，供 message_saved envelope；补 run:end/final step + 终态 envelope。
  const finalMessage = resolveFinalMessage(deps, input);
  recordTerminal(deps, input, "completed", finalMessage, null);
  return { content: result.content, success: true, tokenUsage, toolCalls };
}

/** 查库取 SDK finalize 写入的最终 assistant 消息（runs.final_message_id → messages）。 */
function resolveFinalMessage(
  deps: SdkRuntimeAdapterDeps,
  input: SdkExecuteRunInput,
): MessageInfo | null {
  const run = deps.conversationStore.getRun(input.sessionId, input.runId);
  if (!run || !run.final_message_id) {
    return null;
  }
  return deps.conversationStore.getMessageById(input.sessionId, run.final_message_id);
}

/**
 * Terminal 落库（方案 A：只写 run:end/final step + outbox envelope，不写最终消息/不改 run 状态——
 * SDK Dispatcher.finalize 已做）。completed 用查到的 finalMessage 的 id/seq；failed/interrupted 无 final。
 */
function recordTerminal(
  deps: SdkRuntimeAdapterDeps,
  input: SdkExecuteRunInput,
  status: "completed" | "failed" | "interrupted",
  finalMessage: MessageInfo | null,
  error: unknown,
): void {
  const isRoot = !input.childAgentId;

  // run_step / 最终 message 由 SDK Dispatcher 独占落库（方案 A 单 store）。本函数只推终态 outbox
  // envelope（root run 的 stream_output(final)/message_saved/agent_ended/run_ended）到实时流。
  const records: RecordedClientEvent[] = isRoot
    ? deps.conversationStore.runInTransaction((tx): RecordedClientEvent[] => {
      const collected: RecordedClientEvent[] = [];
      if (status === "completed" && finalMessage) {
        collected.push(appendEnvelope(tx, deps.clientEvents, input, {
          type: "stream_output",
          session_id: input.sessionId,
          run_id: input.runId,
          call_id: input.rootCallId,
          agent_id: input.agent.agent_name,
          payload: { phase: "final", content: finalMessage.content },
        }));
        collected.push(appendEnvelope(tx, deps.clientEvents, input, {
          type: "state_sync",
          session_id: input.sessionId,
          run_id: input.runId,
          payload: { category: "message_saved", ref: { message_id: finalMessage.id, seq: finalMessage.seq } },
        }));
        collected.push(appendEnvelope(tx, deps.clientEvents, input, {
          type: "agent_ended",
          session_id: input.sessionId,
          run_id: input.runId,
          call_id: input.rootCallId,
          agent_id: input.agent.agent_name,
          payload: { phase: "end", result: finalMessage.content.slice(0, 500), success: true },
        }));
        collected.push(appendEnvelope(tx, deps.clientEvents, input, {
          type: "run_ended",
          session_id: input.sessionId,
          run_id: input.runId,
          payload: { status: "completed" },
        }));
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        collected.push(appendEnvelope(tx, deps.clientEvents, input, {
          type: "agent_ended",
          session_id: input.sessionId,
          run_id: input.runId,
          call_id: input.rootCallId,
          agent_id: input.agent.agent_name,
          payload: {
            phase: "end",
            result: status === "interrupted" ? "[已停止生成]" : errorMessage.slice(0, 500),
            success: false,
          },
        }));
        collected.push(appendEnvelope(tx, deps.clientEvents, input, {
          type: "run_ended",
          session_id: input.sessionId,
          run_id: input.runId,
          payload: { status, ...(status !== "interrupted" ? { reason: errorMessage } : {}) },
        }));
      }
      return collected;
    })
    : [];
  deps.clientEvents.deliver(records);
}

function appendEnvelope(
  tx: Parameters<Parameters<ConversationStore["runInTransaction"]>[0]>[0],
  clientEvents: DurableClientEventPublisher,
  input: { sessionId: string; runId: string },
  envelope: Envelope,
): RecordedClientEvent {
  return clientEvents.recordInTransaction(tx, input.sessionId, envelope, {
    runId: input.runId,
    aggregateType: "run",
    aggregateId: input.runId,
  });
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
