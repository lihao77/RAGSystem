/**
 * Store 适配器（方案 A）—— 把 SDK 的 RuntimeStore 端口委托到 backend-ts ConversationStore。
 *
 * 单一 store 实例：SDK Dispatcher 与 backend-ts 共用同一个 ConversationStore（同一 sqlite 连接、
 * 同一 conversation.db），无双写、无第二库。SDK 内核 + Dispatcher 独占 run/message/run_step 落库，
 * backend-ts run-engine 退化为事件消费端（只翻译 + 推 outbox envelope）。
 *
 * 两处阻抗适配：
 *   1. runId-only 查询（getRun/updateRunStatus）：SDK 不传 sessionId，但 backend-ts 需要。
 *      用 runId→sessionId 映射解决（createRun 时记入，createRun 恒早于 finalize）。
 *   2. insertCompressionMessage：SDK 的 RuntimeTx 有此方法，backend-ts ConversationStoreTransaction 没有。
 *      在适配 tx 内用 tx.addMessage + compression metadata 实现（与 messageStore.insertCompressionMessage
 *      内部实现一致，且在同一事务内）。
 *
 * 字段大小写：SDK MessageInfo camelCase ↔ backend-ts MessageInfo snake_case，边界 mappers 转换。
 */
import type {
  AddMessageInput,
  AddRunStepInput,
  CreateRunInput,
  InsertCompressionMessageInput,
  MessageInfo as SdkMessageInfo,
  RunRecord,
  RunStatus,
  RuntimeStore,
  RuntimeTx,
} from "@ragsystem/agent-sdk";
import type {
  ConversationStore,
  ConversationStoreTransaction,
} from "../../../contracts/conversation-store/index.js";
import type { MessageInfo as BackendMessageInfo } from "../../../contracts/session.js";
import type { MessageToolCall } from "../../../contracts/session.js";

export interface SdkStoreAdapterOptions {
  conversationStore: ConversationStore;
}

export class SdkStoreAdapter implements RuntimeStore {
  /** runId → sessionId 映射（createRun 记入，供 getRun/updateRunStatus 查 sessionId）。 */
  private readonly runSessions = new Map<string, string>();
  private readonly store: ConversationStore;

  constructor(options: SdkStoreAdapterOptions) {
    this.store = options.conversationStore;
  }

  runInTransaction<T>(fn: (tx: RuntimeTx) => T): T {
    return this.store.runInTransaction((backendTx) => {
      const sdkTx = new SdkTxAdapter(backendTx);
      return fn(sdkTx);
    });
  }

  listMessages(sessionId: string, threadKey?: string, limit?: number): SdkMessageInfo[] {
    const messages = this.store.getRecentMessages(sessionId, limit, threadKey ?? null);
    return messages.map(toSdkMessageInfo);
  }

  getMessageById(sessionId: string, messageId: string): SdkMessageInfo | null {
    const message = this.store.getMessageById(sessionId, messageId);
    return message ? toSdkMessageInfo(message) : null;
  }

 createRun(input: CreateRunInput): void {
   this.runSessions.set(input.id, input.sessionId);
   // root run（threadKey="root"）：parentCallId 置 null（SDK 把 rootCallId 塞进了 parentCallId）。
   // child run（threadKey="child:*"）：用 SDK 透传的 parentCallId 指向父 agent。
   const isRoot = input.threadKey === "root";
    this.store.createRun(buildBackendCreateRun(input, isRoot));
 }

  getRun(runId: string): RunRecord | null {
    const sessionId = this.resolveSessionId(runId);
    if (sessionId === null) {
      return null;
    }
    const run = this.store.getRun(sessionId, runId);
    return run ? toSdkRunRecord(run, sessionId) : null;
  }

  updateRunStatus(runId: string, status: RunStatus, finalMessageId?: string): boolean {
    const sessionId = this.resolveSessionId(runId);
    if (sessionId === null) {
      return false;
    }
    return this.store.updateRunStatus(runId, sessionId, status, finalMessageId ?? null);
  }

  close(): void {
    this.runSessions.clear();
  }

  private resolveSessionId(runId: string): string | null {
    return this.runSessions.get(runId) ?? null;
  }
}

/**
 * 事务适配器：SDK RuntimeTx → backend-ts ConversationStoreTransaction。
 * insertCompressionMessage 在适配层实现（backend-ts tx 无此方法）。
 */
class SdkTxAdapter implements RuntimeTx {
  constructor(private readonly tx: ConversationStoreTransaction) {}

  addMessage(input: AddMessageInput): SdkMessageInfo {
    const message = this.tx.addMessage({
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      metadata: input.metadata,
      ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
      ...(input.toolCallId ? { toolCallId: input.toolCallId } : {}),
      ...(input.name ? { name: input.name } : {}),
      ...(input.messageId ? { messageId: input.messageId } : {}),
      ...(input.threadKey !== undefined ? { threadKey: input.threadKey } : {}),
      ...(input.childAgentId !== undefined ? { childAgentId: input.childAgentId } : {}),
    });
    return toSdkMessageInfo(message);
  }

  addRunStep(input: AddRunStepInput): import("@ragsystem/agent-sdk").RunStepRecord {
    const step = this.tx.addRunStep({
      sessionId: input.sessionId,
      runId: input.runId,
      stepType: input.stepType,
      payload: input.payload,
      ...(input.messageId !== undefined ? { messageId: input.messageId } : {}),
    });
    return {
      id: String(step.id),
      sessionId: input.sessionId,
      runId: input.runId,
      stepType: step.step_type,
      payload: { ...input.payload, stepOrder: step.step_order },
      messageId: input.messageId ?? null,
      createdAt: new Date().toISOString(),
    };
  }

  updateRunStepsMessageId(sessionId: string, runId: string, messageId: string): number {
    return this.tx.updateRunStepsMessageId(sessionId, runId, messageId);
  }

  /**
   * insertCompressionMessage：backend-ts tx 无此方法，用 addMessage + compression metadata 实现。
   * 与 messageStore.insertCompressionMessage 内部一致（compression:true + replaces_up_to_seq）。
   */
  insertCompressionMessage(input: InsertCompressionMessageInput): SdkMessageInfo {
    const metadata: Record<string, unknown> = { ...(input.metadata ?? {}), compression: true };
    if (input.replacesUpToSeq !== undefined) {
      metadata.replaces_up_to_seq = input.replacesUpToSeq;
    }
    return this.addMessage({
      sessionId: input.sessionId,
      role: "assistant",
      content: input.content,
      metadata,
      ...(input.threadKey !== undefined ? { threadKey: input.threadKey } : {}),
      childAgentId: null,
    });
  }
}

/** 构造 backend-ts createRun 入参（exactOptionalPropertyTypes：显式 undefined 处理）。 */
function buildBackendCreateRun(
  input: CreateRunInput,
  isRoot: boolean,
): Parameters<ConversationStore["createRun"]>[0] {
  const result: Parameters<ConversationStore["createRun"]>[0] = {
    runId: input.id,
    sessionId: input.sessionId,
    status: "running",
    threadKey: input.threadKey,
    parentCallId: isRoot ? null : (input.parentCallId ?? null),
  };
 if (input.agentName !== undefined) {
   result.agentName = input.agentName;
 }
  // entrypoint/taskSummary 是非空 string（backend-ts createRun 不接受 null），null 时省略。
  if (input.entrypoint !== undefined && input.entrypoint !== null) {
    result.entrypoint = input.entrypoint;
  }
  if (input.taskSummary !== undefined && input.taskSummary !== null) {
    result.taskSummary = input.taskSummary;
  }
 if (input.userId !== undefined) {
    result.userId = input.userId;
  }
  return result;
}

// ────────────────────────────── 字段大小写映射 ──────────────────────────────

/** backend-ts MessageInfo（snake_case）→ SDK MessageInfo（camelCase）。 */
function toSdkMessageInfo(message: BackendMessageInfo): SdkMessageInfo {
  const info: SdkMessageInfo = {
    id: message.id,
    seq: message.seq,
    sessionId: message.session_id,
    role: message.role,
    content: message.content,
    metadata: message.metadata,
    createdAt: message.created_at,
    threadKey: message.thread_key,
    childAgentId: message.child_agent_id,
  };
 if (message.tool_calls) {
    info.toolCalls = message.tool_calls.map((call: MessageToolCall) => ({
      id: call.id,
      type: "function" as const,
      function: { name: call.function.name, arguments: call.function.arguments },
    }));
  }
  if (message.tool_call_id) {
    info.toolCallId = message.tool_call_id;
  }
  if (message.name) {
    info.name = message.name;
  }
  return info;
}

/** backend-ts RunInfo（snake_case）→ SDK RunRecord（camelCase）。 */
function toSdkRunRecord(run: NonNullable<ReturnType<ConversationStore["getRun"]>>, sessionId: string): RunRecord {
  return {
    id: run.run_id,
    sessionId,
    status: run.status as RunStatus,
    rootCallId: "",
    threadKey: run.thread_key,
    parentCallId: run.parent_call_id,
    finalMessageId: run.final_message_id,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}
