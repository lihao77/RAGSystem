/**
 * Runtime 适配器（方案 A 的集成钥匙）—— 组装投影 + ToolRegistry + store 适配器 +
 * createRuntime，跑 SDK 事件循环 + 翻译 + terminal。
 *
 * SDK 内核 + Dispatcher 独占 run/message/run_step 落库（经 SdkStoreAdapter 委托 ConversationStore）；
 * 本适配器只做：组装 createRuntime 入参、消费 KernelEvent 翻译成 Envelope 推 outbox（无 DB 落库，
 * 避免 SDK 与 backend-ts 双写 message/run_step）、terminal 补 run:end/final step + 终态 envelope
 *（final assistant 消息由 SDK Dispatcher.finalize 已写，此处只查库取其 id/seq 供 message_saved）。
 */
import { createRuntime, createToolRegistry, prepareTool, type CreateRuntimeOptions, type SessionMetadataPort } from "@ragsystem/agent-sdk";
import type { AgentPromptContext, Tool, ToolExecContext, ToolExecutionResult, ToolRegistry } from "@ragsystem/agent-sdk";
import { translateKernelEvent, type WireTranslationContext } from "@ragsystem/agent-protocol";
import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { HookRegistry } from "@ragsystem/agent-sdk";
import type { ModelProviderConfig } from "../../../contracts/model-adapter.js";
import type { ConversationStore } from "../../../contracts/conversation-store/index.js";
import type { MessageInfo } from "../../../contracts/session.js";
import type { Envelope } from "../../../contracts/events.js";
import type { AgentExecutionEventPublisher } from "../execution/event-publisher.js";
import type { DurableClientEventPublisher, RecordedClientEvent } from "../../runtime/event-outbox/client-event-publisher.js";
import type { PermissionPolicyService } from "../../runtime/permission-policy-service.js";
import type { PendingInteractionService } from "../../runtime/pending-interaction-service.js";
import type { BackendToolsDeps } from "../../../tools/registry.js";
import { createBackendTools } from "../../../tools/registry.js";
import type { CodeExecutionToolService } from "../../../tools/CodeExecutionTool/CodeExecution.js";
import type { TaskToolService } from "../../../tools/TaskTools/TaskExecution.js";
import { projectAgentProfile } from "./projection.js";
import { SdkStoreAdapter } from "./sdk-store-adapter.js";
import { MemoryIndexContextSource, isMemoryEnabled } from "../memory/index.js";
import { registerGateHook } from "./gate-hook.js";
import { PathApprovalService } from "../../../services/runtime/path-service.js";

export interface SdkRuntimeAdapterDeps {
  conversationStore: ConversationStore;
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
  /** 消费端 hook 注册回调（可选）；透传给 createRuntime，让 backend 注册 tool.before/after、round.before 等 handler。 */
  hooks?: (registry: HookRegistry) => void;
  /** microcompact 缓存 TTL（秒）；透传 createRuntime，与 snapshot 路径同源（systemConfig 单一来源）。 */
  microcompactTtlSeconds?: number;
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
  const storeAdapter = new SdkStoreAdapter({ conversationStore: deps.conversationStore });
  // session metadata 端口：委托真实 ConversationStore，让 memory 源能读到 team/workspace_root，
  // 解析出 team/agent/workspace scope（否则只 session scope 存活，其余静默丢弃）。
  const sessionMetadata: SessionMetadataPort = {
    getSession: (sessionId) => {
      const session = deps.conversationStore.getSession(sessionId);
      return session ? { metadata: session.metadata ?? {} } : null;
    },
    updateSessionMetadata: (sessionId, patch) => deps.conversationStore.updateSessionMetadata(sessionId, patch),
  };

  // per-run 构建工具集合：各工厂闭包绑定 agent，返回 SDK Tool[]
  const teamName = asString(input.sessionMetadata.team);
  const pathService = new PathApprovalService();
  const tools: Tool[] = createBackendTools({
    ...deps.toolsDeps,
    agent: input.agent,
    ...(teamName ? { teamName } : {}),
  }, pathService);
  const registry: ToolRegistry = createToolRegistry({ tools });

  // 算 promptContext（仅 backgroundTasks）；tools 由 SDK 内核从 registry 自动填充。
  // skill / delegation 的可用清单已由对应工具（skill 工具、call_agent）以 enum + extended_usage 自描述，
  // 统一进 tools 段，不再经 promptContext 注入。
  const promptContext: Omit<AgentPromptContext, "tools"> = {
    ...(input.agent.tasks.background ? { backgroundTasks: true } : {}),
  };

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

  // memory context source（业务 source，经 extraContextSources 注入；SDK 不再内置 memory）。
  const extraContextSources = isMemoryEnabled(input.agent.memory)
    ? [new MemoryIndexContextSource(sessionMetadata, input.agent.memory, input.agent.agent_name, { dataRoot: deps.dataRoot })]
    : [];
  const runtimeOpts: CreateRuntimeOptions = {
    profile,
    tools: registry,
    dataRoot: deps.dataRoot,
    store: storeAdapter,
    extraContextSources,
    promptContext,
    execContext: baseExecCtx,
    ...(deps.microcompactTtlSeconds !== undefined ? { microcompactTtlSeconds: deps.microcompactTtlSeconds } : {}),
    hooks: (registry) => {
      registerGateHook(registry, {
        permissionPolicy: deps.permissionPolicy,
        pendingInteractions: deps.pendingInteractions,
        pathService,
        agentName: input.agent.agent_name,
      });
      deps.hooks?.(registry);
    },
    ...(waitForToolResult ? { waitForToolResult } : {}),
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
    return { content: message, success: false };
  }

  await consumeEvents;
  runtime.close();

  // completed：SDK Dispatcher.finalize 已落最终 assistant 消息 + updateRunStatus。
  // 查库取该消息 id/seq，供 message_saved envelope；补 run:end/final step + 终态 envelope。
  const finalMessage = resolveFinalMessage(deps, input);
  recordTerminal(deps, input, "completed", finalMessage, null);
  return { content: result.content, success: true };
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

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
