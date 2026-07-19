import { randomUUID } from "node:crypto";

import { RecoverableInterrupt } from "@ragsystem/agent-protocol";
import type { Envelope } from "../../contracts/events.js";
import type { ApprovalRequest, UserInputRequest } from "../../contracts/execution.js";
import type { InteractionKind, InteractionResponsePayload } from "../../contracts/interactions.js";
import type { ClientEventPublisher } from "./event-outbox/client-event-publisher.js";
import type { IPendingInteractionStore, PendingInteractionRecord } from "../../contracts/conversation-store/index.js";
import type { PendingInteractionPort } from "../../contracts/pending-interactions.js";

export interface PendingUserInputRequest {
  sessionId: string;
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  parentCallId: string | null;
  taskId?: string | null | undefined;
  requestId?: string | null | undefined;
  toolCallId: string;
  interactionBatchId?: string | undefined;
  onInteractionRequired?: ((notice: InteractionRequiredNotice) => void) | undefined;
  deadlineMs: number;
  task: string;
  executionKind?: string | undefined;
  botId?: string | undefined;
  chatId?: string | undefined;
  agentName?: string | null | undefined;
  prompt: string;
  inputType?: string | null | undefined;
  options?: string[] | undefined;
  extra?: Record<string, unknown> | undefined;
  signal?: AbortSignal | undefined;
}

export interface PendingUserInputResolution {
  inputId: string;
  value: string;
  respondedAt: string;
}

export interface PendingApprovalRequest {
  sessionId: string;
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  parentCallId: string | null;
  taskId?: string | null | undefined;
  requestId?: string | null | undefined;
  toolCallId: string;
  interactionBatchId?: string | undefined;
  onInteractionRequired?: ((notice: InteractionRequiredNotice) => void) | undefined;
  deadlineMs: number;
  task: string;
  executionKind?: string | undefined;
  botId?: string | undefined;
  chatId?: string | undefined;
  agentName?: string | null | undefined;
  approvalType?: string | null | undefined;
  toolName: string;
  arguments?: Record<string, unknown> | undefined;
  riskLevel?: string | null | undefined;
  description?: string | null | undefined;
  permissionMode?: string | null | undefined;
  approvalReason?: string | null | undefined;
  approvalReasonCodes?: string[] | undefined;
  approvalSecondaryReasons?: string[] | undefined;
  approvalHook?: Record<string, unknown> | undefined;
  externalPathCandidates?: string[] | undefined;
  signal?: AbortSignal | undefined;
}

export interface PendingApprovalResolution {
  approvalId: string;
  approved: boolean;
  message: string;
  respondedAt: string;
}

export interface PendingInteractionResolutionResult {
  resolved: boolean;
  needsResume: boolean;
  kind: InteractionKind;
  interactionId: string;
  rootRunId?: string | undefined;
  approvalId?: string | undefined;
  toolCallId?: string | undefined;
  approved?: boolean | undefined;
  message?: string | undefined;
  error?: string | undefined;
}

export type ApprovalCacheResolution =
  | { approved: boolean; message: string }
  | { value: string };

export interface ApprovalMeta {
  approvalId: string;
  sessionId: string;
  toolCallId: string;
  rootRunId: string;
  runId: string;
  kind: InteractionKind;
  batchId: string;
  resolved: boolean;
  task: string;
  requestId: string | null;
  executionKind?: string | undefined;
  botId?: string | undefined;
  chatId?: string | undefined;
  toolName?: string | undefined;
  riskLevel?: string | undefined;
  reason?: string | undefined;
  prompt?: string | undefined;
  options?: string[] | undefined;
}

export interface InteractionRequiredNotice {
  interactionId: string;
  sessionId: string;
  rootRunId: string;
  batchId: string;
  kind: InteractionKind;
}

export interface PendingInteractionRespondResult {
  resolved: boolean;
  needsResume: boolean;
  kind: InteractionKind;
  interactionId: string;
  rootRunId?: string | undefined;
  approvalId?: string | undefined;
  toolCallId?: string | undefined;
}

interface PendingInputEntry {
  sessionId: string;
  inputId: string;
  runId: string;
  abortListener?: (() => void) | undefined;
  resolve(value: PendingUserInputResolution): void;
  reject(error: Error): void;
}

interface PendingApprovalEntry {
  sessionId: string;
  approvalId: string;
  runId: string | null;
  taskId: string | null;
  requestId: string | null;
  abortListener?: (() => void) | undefined;
  resolve(value: PendingApprovalResolution): void;
  reject(error: Error): void;
}

export class PendingInteractionService implements PendingInteractionPort {
  private readonly pendingInputs = new Map<string, PendingInputEntry>();
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  private readonly approvalCache = new Map<string, ApprovalCacheResolution>();
  private readonly approvalMeta = new Map<string, ApprovalMeta>();

  constructor(
    private readonly clientEvents: ClientEventPublisher,
    private readonly durableStore: IPendingInteractionStore | null = null,
  ) {}

  /** 恢复入口写入已完成的审批/输入结果；工具按 session+toolCallId 消费一次。 */
  setApprovalCache(sessionId: string, toolCallId: string, resolution: ApprovalCacheResolution): void {
    this.approvalCache.set(cacheKey(sessionId, toolCallId), resolution);
  }

  /** 恢复执行器消费一次挂起凭证。 */
  peekApprovalMeta(approvalId: string, sessionId: string): ApprovalMeta | null {
    return this.approvalMeta.get(approvalId) ?? this.loadApprovalMeta(sessionId, approvalId);
  }

  /** 恢复执行器完成校验后领取整批已响应交互。 */
  takeApprovalMeta(approvalId: string, sessionId?: string): ApprovalMeta | null {
    const meta = this.approvalMeta.get(approvalId) ?? (sessionId ? this.loadApprovalMeta(sessionId, approvalId) : null);
    if (meta) {
      for (const [id, candidate] of this.approvalMeta) {
        if (candidate.sessionId === meta.sessionId && candidate.batchId === meta.batchId && candidate.resolved) {
          this.approvalMeta.delete(id);
        }
      }
    }
    return meta;
  }

  /** 恢复启动失败时把已领取 batch 退回可重试状态。 */
  releaseApprovalBatch(meta: ApprovalMeta): void {
    if (!this.durableStore) return;
    this.durableStore.releasePendingBatch(meta.sessionId, meta.batchId);
  }

  /** 查询同一 root 最新生成的挂起凭证，供续跑中再次挂起回调。 */
  findLatestApprovalMeta(rootRunId: string, sessionId?: string): ApprovalMeta | null {
    const durable = this.listDurableMeta(rootRunId, sessionId);
    if (durable.length > 0) return durable.at(-1) ?? null;
    const matches = Array.from(this.approvalMeta.values()).filter((meta) => meta.rootRunId === rootRunId && !meta.resolved);
    return matches.at(-1) ?? null;
  }

  /** 查询同一 root 当前未响应的整批交互，daemon 用于一次发送全部卡片。 */
  listPendingApprovalMeta(rootRunId: string, sessionId?: string): ApprovalMeta[] {
    const durable = this.listDurableMeta(rootRunId, sessionId);
    if (durable.length > 0) return durable;
    return Array.from(this.approvalMeta.values()).filter((meta) => meta.rootRunId === rootRunId && !meta.resolved);
  }

  /** run 终止后清理该 root 的 durable 状态与一次性缓存。 */
  finalizeRoot(sessionId: string, rootRunId: string, completed: boolean): void {
    const records = this.durableStore?.listPendingInteractions({
      sessionId,
      rootRunId,
      statuses: ["waiting", "suspended", "resolved", "resuming"],
    }) ?? [];
    for (const record of records) {
      this.approvalCache.delete(cacheKey(sessionId, record.tool_call_id));
      this.approvalMeta.delete(record.interaction_id);
      this.durableStore?.updatePendingInteractionStatus({
        sessionId,
        interactionId: record.interaction_id,
        from: ["waiting", "suspended", "resolved", "resuming"],
        status: completed && (record.status === "resolved" || record.status === "resuming") ? "consumed" : "cancelled",
      });
    }
  }

  waitForUserInput(input: PendingUserInputRequest): Promise<PendingUserInputResolution> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      return Promise.reject(new Error("request_user_input 缺少 session_id"));
    }
    if (input.signal?.aborted) {
      return Promise.reject(new Error("request_user_input cancelled"));
    }

    const cached = this.takeApprovalCache(sessionId, input.toolCallId);
    if (cached) {
      if (!("value" in cached)) {
        return Promise.reject(new Error("request_user_input 缓存结果类型不匹配"));
      }
      return Promise.resolve({
        inputId: randomUUID(),
        value: cached.value,
        respondedAt: new Date().toISOString(),
      });
    }

    const inputId = randomUUID();
    const prompt = input.prompt.trim();
    const inputType = normalizeInputType(input.inputType);
    const options = input.options ?? [];
    const extra = input.extra ?? {};
    const meta = buildApprovalMeta(inputId, sessionId, "user_input", input);
    this.approvalMeta.set(inputId, meta);
    this.persistPendingMeta(meta);

    const respondPromise = new Promise<PendingUserInputResolution>((resolve, reject) => {
      const entry: PendingInputEntry = {
        sessionId,
        inputId,
        runId: input.runId,
        resolve,
        reject,
      };
      if (input.signal) {
        const onAbort = (): void => {
          this.pendingInputs.delete(inputId);
          this.approvalMeta.delete(inputId);
          reject(new Error("request_user_input cancelled"));
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        entry.abortListener = () => input.signal?.removeEventListener("abort", onAbort);
      }
      this.pendingInputs.set(inputId, entry);
    });

    const interactionEvent: Envelope = {
      type: "interaction",
      session_id: sessionId,
      call_id: inputId,
      ...(input.runId ? { run_id: input.runId } : {}),
      payload: {
        kind: "user_input",
        phase: "required",
        tool: "request_user_input",
        prompt,
        input: { input_type: inputType, options, extra, tool_call_id: input.toolCallId ?? null, agent_name: input.agentName ?? null },
      },
    };
    this.publish(sessionId, interactionEvent);
    input.onInteractionRequired?.({
      interactionId: inputId,
      sessionId,
      rootRunId: meta.rootRunId,
      batchId: meta.batchId,
      kind: meta.kind,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<PendingUserInputResolution>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        this.durableStore?.updatePendingInteractionStatus({
          sessionId,
          interactionId: inputId,
          from: ["waiting"],
          status: "suspended",
        });
        const entry = this.pendingInputs.get(inputId);
        if (entry) {
          this.pendingInputs.delete(inputId);
          entry.abortListener?.();
        }
        reject(new RecoverableInterrupt({
          sessionId,
          runId: input.runId,
          rootRunId: input.rootRunId,
          parentRunId: input.parentRunId,
          parentCallId: input.parentCallId,
          toolCallId: input.toolCallId,
          kind: "user_input",
        }));
      }, Math.max(0, input.deadlineMs));
    });
    return Promise.race([respondPromise, timeoutPromise]).finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });
  }

  respondUserInput(sessionId: string, inputId: string, payload: UserInputRequest): PendingInteractionRespondResult {
    const entry = this.pendingInputs.get(inputId);
    const value = payload.value ?? "";
    if (entry && entry.sessionId === sessionId) {
      this.pendingInputs.delete(inputId);
      const meta = this.approvalMeta.get(inputId);
      if (meta) meta.resolved = true;
      if (meta) this.setApprovalCache(sessionId, meta.toolCallId, { value });
      this.durableStore?.updatePendingInteractionStatus({
        sessionId,
        interactionId: inputId,
        from: ["waiting"],
        status: "resolved",
        resolution: { value },
      });
      entry.abortListener?.();
      this.publishUserInputResolution(entry, value);
      entry.resolve({
        inputId,
        value,
        respondedAt: new Date().toISOString(),
      });
      return { resolved: true, needsResume: false, kind: "user_input", interactionId: inputId };
    }
    const durableRecord = this.durableStore?.getPendingInteraction(sessionId, inputId);
    if (durableRecord && (durableRecord.status === "resuming" || durableRecord.status === "consumed" || durableRecord.status === "cancelled")) {
      return { resolved: durableRecord.status !== "cancelled", needsResume: false, kind: "user_input", interactionId: inputId };
    }
    const meta = this.approvalMeta.get(inputId) ?? (durableRecord ? metaFromRecord(durableRecord) : null);
    if (!meta || meta.sessionId !== sessionId || meta.kind !== "user_input") {
      return { resolved: false, needsResume: false, kind: "user_input", interactionId: inputId };
    }
    this.setApprovalCache(sessionId, meta.toolCallId, { value });
    meta.resolved = true;
    this.durableStore?.updatePendingInteractionStatus({
      sessionId,
      interactionId: inputId,
      from: ["waiting", "suspended"],
      status: "resolved",
      resolution: { value },
    });
    this.publishUserInputResolution(meta, value);
    return resumeResult(meta, this.isBatchResolved(meta));
  }

  waitForApproval(input: PendingApprovalRequest): Promise<PendingApprovalResolution> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      return Promise.reject(new Error("approval 缺少 session_id"));
    }
    if (input.signal?.aborted) {
      return Promise.reject(new Error("approval cancelled"));
    }

    const cached = this.takeApprovalCache(sessionId, input.toolCallId);
    if (cached) {
      if (!("approved" in cached)) {
        return Promise.reject(new Error("approval 缓存结果类型不匹配"));
      }
      return Promise.resolve({
        approvalId: randomUUID(),
        approved: cached.approved,
        message: cached.message,
        respondedAt: new Date().toISOString(),
      });
    }

    const approvalId = randomUUID();
    const meta = buildApprovalMeta(approvalId, sessionId, "approval", input);
    this.approvalMeta.set(approvalId, meta);
    this.persistPendingMeta(meta);
    const respondPromise = new Promise<PendingApprovalResolution>((resolve, reject) => {
      const entry: PendingApprovalEntry = {
        sessionId,
        approvalId,
        runId: input.runId ?? null,
        taskId: input.taskId ?? null,
        requestId: input.requestId ?? null,
        resolve,
        reject,
      };
      if (input.signal) {
        const onAbort = (): void => {
          this.pendingApprovals.delete(approvalId);
          this.approvalMeta.delete(approvalId);
          reject(new Error("approval cancelled"));
        };
        input.signal.addEventListener("abort", onAbort, { once: true });
        entry.abortListener = () => input.signal?.removeEventListener("abort", onAbort);
      }
      this.pendingApprovals.set(approvalId, entry);
    });

    const interactionEvent: Envelope = {
      type: "interaction",
      session_id: sessionId,
      call_id: approvalId,
      ...(input.runId ? { run_id: input.runId } : {}),
      payload: {
        kind: "approval",
        phase: "required",
        tool: input.toolName,
        risk_level: (input.riskLevel === "low" || input.riskLevel === "medium" || input.riskLevel === "high" ? input.riskLevel : undefined),
        prompt: input.description ?? "",
        input: {
          approval_id: approvalId,
          approval_type: input.approvalType ?? null,
          tool_call_id: input.toolCallId ?? null,
          agent_name: input.agentName ?? null,
          arguments: input.arguments ?? {},
          permission_mode: input.permissionMode ?? null,
          approval_reason: input.approvalReason ?? "",
          approval_reason_codes: input.approvalReasonCodes ?? [],
          approval_secondary_reasons: input.approvalSecondaryReasons ?? [],
          approval_hook: input.approvalHook ?? {},
          external_path_candidates: input.externalPathCandidates ?? [],
        },
        message: input.approvalReason ?? "",
      },
    };
    this.publish(sessionId, interactionEvent);
    input.onInteractionRequired?.({
      interactionId: approvalId,
      sessionId,
      rootRunId: meta.rootRunId,
      batchId: meta.batchId,
      kind: meta.kind,
    });

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<PendingApprovalResolution>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        this.durableStore?.updatePendingInteractionStatus({
          sessionId,
          interactionId: approvalId,
          from: ["waiting"],
          status: "suspended",
        });
        const entry = this.pendingApprovals.get(approvalId);
        if (entry) {
          this.pendingApprovals.delete(approvalId);
          entry.abortListener?.();
        }
        reject(new RecoverableInterrupt({
          sessionId,
          runId: input.runId,
          rootRunId: input.rootRunId,
          parentRunId: input.parentRunId,
          parentCallId: input.parentCallId,
          toolCallId: input.toolCallId,
          kind: "approval",
        }));
      }, Math.max(0, input.deadlineMs));
    });
    return Promise.race([respondPromise, timeoutPromise]).finally(() => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    });
  }

  respondApproval(sessionId: string, approvalId: string, payload: ApprovalRequest): PendingInteractionRespondResult {
    const entry = this.pendingApprovals.get(approvalId);
    const approved = Boolean(payload.approved);
    const message = payload.message ?? "";
    if (entry && entry.sessionId === sessionId) {
      this.pendingApprovals.delete(approvalId);
      const meta = this.approvalMeta.get(approvalId);
      if (meta) meta.resolved = true;
      if (meta) this.setApprovalCache(sessionId, meta.toolCallId, { approved, message });
      this.durableStore?.updatePendingInteractionStatus({
        sessionId,
        interactionId: approvalId,
        from: ["waiting"],
        status: "resolved",
        resolution: { approved, message },
      });
      entry.abortListener?.();
      this.publishApprovalResolution(entry, { approved, message });
      entry.resolve({
        approvalId,
        approved,
        message,
        respondedAt: new Date().toISOString(),
      });
      return { resolved: true, needsResume: false, kind: "approval", interactionId: approvalId };
    }
    const durableRecord = this.durableStore?.getPendingInteraction(sessionId, approvalId);
    if (durableRecord && (durableRecord.status === "resuming" || durableRecord.status === "consumed" || durableRecord.status === "cancelled")) {
      return { resolved: durableRecord.status !== "cancelled", needsResume: false, kind: "approval", interactionId: approvalId };
    }
    const meta = this.approvalMeta.get(approvalId) ?? (durableRecord ? metaFromRecord(durableRecord) : null);
    if (!meta || meta.sessionId !== sessionId || meta.kind !== "approval") {
      return { resolved: false, needsResume: false, kind: "approval", interactionId: approvalId };
    }
    this.setApprovalCache(sessionId, meta.toolCallId, { approved, message });
    meta.resolved = true;
    this.durableStore?.updatePendingInteractionStatus({
      sessionId,
      interactionId: approvalId,
      from: ["waiting", "suspended"],
      status: "resolved",
      resolution: { approved, message },
    });
    this.publishApprovalResolution(meta, { approved, message });
    return resumeResult(meta, this.isBatchResolved(meta));
  }

  respondInteraction(
    sessionId: string,
    interactionId: string,
    payload: InteractionResponsePayload,
  ): PendingInteractionResolutionResult {
    const kind = normalizeInteractionKind(payload);
    if (kind === "approval") {
      const approved = Boolean(payload.approved);
      const message = payload.message ?? "";
      const result = this.respondApproval(sessionId, interactionId, { approved, message });
      return {
        ...result,
        kind,
        interactionId,
        approved,
        message,
        ...(result.resolved ? {} : { error: "未找到对应的审批请求，可能已被取消或不存在" }),
      };
    }

    const result = this.respondUserInput(sessionId, interactionId, { value: payload.value ?? "" });
    return {
      ...result,
      kind,
      interactionId,
      ...(result.resolved ? {} : { error: "未找到对应的输入请求，可能已被取消或不存在" }),
    };
  }

  cancelSession(
    sessionId: string,
    reason = "request_user_input cancelled",
    options: { persist?: boolean } = {},
  ): void {
    for (const [inputId, entry] of this.pendingInputs.entries()) {
      if (entry.sessionId !== sessionId) {
        continue;
      }
      this.pendingInputs.delete(inputId);
      entry.abortListener?.();
      entry.reject(new Error(reason));
    }
    for (const [approvalId, entry] of this.pendingApprovals.entries()) {
      if (entry.sessionId !== sessionId) {
        continue;
      }
      this.pendingApprovals.delete(approvalId);
      entry.abortListener?.();
      entry.reject(new Error(reason));
    }
    const cachePrefix = `${sessionId}:`;
    for (const key of this.approvalCache.keys()) {
      if (key.startsWith(cachePrefix)) {
        this.approvalCache.delete(key);
      }
    }
    for (const [approvalId, meta] of this.approvalMeta.entries()) {
      if (meta.sessionId === sessionId) {
        this.approvalMeta.delete(approvalId);
      }
    }
    if (options.persist !== false) this.durableStore?.cancelPendingInteractions(sessionId);
  }

  isUserInputPending(sessionId: string, inputId: string): boolean {
    const entry = this.pendingInputs.get(inputId);
    return Boolean(entry && entry.sessionId === sessionId);
  }

  isApprovalPending(sessionId: string, approvalId: string): boolean {
    const entry = this.pendingApprovals.get(approvalId);
    return Boolean(entry && entry.sessionId === sessionId);
  }

  private publish(sessionId: string, event: Envelope): void {
    const runId = typeof event.run_id === "string" && event.run_id ? event.run_id : null;
    this.clientEvents.publish(sessionId, event, {
      runId,
      aggregateType: runId ? "run" : "session",
      aggregateId: runId ?? sessionId,
    });
  }

  private publishApprovalResolution(entry: Pick<PendingApprovalEntry, "sessionId" | "approvalId" | "runId">, payload: { approved: boolean; message: string }): void {
    const event: Envelope = {
      type: "interaction",
      session_id: entry.sessionId,
      call_id: entry.approvalId,
      ...(entry.runId ? { run_id: entry.runId } : {}),
      payload: {
        kind: "approval",
        phase: "responded",
        approved: payload.approved,
        message: payload.message,
      },
    };
    this.publish(entry.sessionId, event);
  }

  private publishUserInputResolution(entry: { sessionId: string; inputId?: string; approvalId?: string; runId: string }, value: string): void {
    const interactionId = entry.inputId ?? entry.approvalId ?? "";
    const event: Envelope = {
      type: "interaction",
      session_id: entry.sessionId,
      call_id: interactionId,
      ...(entry.runId ? { run_id: entry.runId } : {}),
      payload: {
        kind: "user_input",
        phase: "responded",
        value,
      },
    };
    this.publish(entry.sessionId, event);
  }

  private takeApprovalCache(sessionId: string, toolCallId: string): ApprovalCacheResolution | null {
    const key = cacheKey(sessionId, toolCallId);
    const resolution = this.approvalCache.get(key) ?? null;
    if (resolution) {
      this.approvalCache.delete(key);
      this.durableStore?.consumePendingResolution(sessionId, toolCallId);
      return resolution;
    }
    const durable = this.durableStore?.consumePendingResolution(sessionId, toolCallId);
    return durable ? resolutionFromRecord(durable) : null;
  }

  private isBatchResolved(meta: ApprovalMeta): boolean {
    const durableUnresolved = this.durableStore?.listPendingInteractions({
      sessionId: meta.sessionId,
      batchId: meta.batchId,
      statuses: ["waiting", "suspended"],
    });
    if (durableUnresolved) return durableUnresolved.length === 0;
    return !Array.from(this.approvalMeta.values()).some((candidate) =>
      candidate.sessionId === meta.sessionId
      && candidate.batchId === meta.batchId
      && !candidate.resolved,
    );
  }

  private persistPendingMeta(meta: ApprovalMeta): void {
    this.durableStore?.createPendingInteraction({
      interactionId: meta.approvalId,
      sessionId: meta.sessionId,
      runId: meta.runId,
      rootRunId: meta.rootRunId,
      toolCallId: meta.toolCallId,
      batchId: meta.batchId,
      kind: meta.kind,
      requestPayload: { ...meta },
    });
  }

  private loadApprovalMeta(sessionId: string, approvalId: string): ApprovalMeta | null {
    if (!this.durableStore) return null;
    const record = this.durableStore.getPendingInteraction(sessionId, approvalId);
    return record ? metaFromRecord(record) : null;
  }

  private listDurableMeta(rootRunId: string, explicitSessionId?: string): ApprovalMeta[] {
    if (!this.durableStore) return [];
    const sessionId = explicitSessionId
      ?? Array.from(this.approvalMeta.values()).find((meta) => meta.rootRunId === rootRunId)?.sessionId;
    if (!sessionId) return [];
    return this.durableStore.listPendingInteractions({
      sessionId,
      rootRunId,
      statuses: ["waiting", "suspended"],
    }).map(metaFromRecord);
  }
}

function cacheKey(sessionId: string, toolCallId: string): string {
  return `${sessionId}:${toolCallId}`;
}

function buildApprovalMeta(
  approvalId: string,
  sessionId: string,
  kind: InteractionKind,
  input: PendingApprovalRequest | PendingUserInputRequest,
): ApprovalMeta {
  return {
    approvalId,
    sessionId,
    toolCallId: input.toolCallId,
    rootRunId: input.rootRunId,
    runId: input.runId,
    kind,
    batchId: input.interactionBatchId?.trim() || `${input.rootRunId}:${input.toolCallId}`,
    resolved: false,
    task: input.task,
    requestId: input.requestId ?? null,
    ...(input.executionKind ? { executionKind: input.executionKind } : {}),
    ...(input.botId ? { botId: input.botId } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
    ...("toolName" in input ? { toolName: input.toolName } : {}),
    ...("riskLevel" in input && input.riskLevel ? { riskLevel: input.riskLevel } : {}),
    ...("approvalReason" in input && input.approvalReason ? { reason: input.approvalReason } : {}),
    ...("prompt" in input ? { prompt: input.prompt } : {}),
    ...("options" in input && input.options ? { options: input.options } : {}),
  };
}

function resumeResult(meta: ApprovalMeta, needsResume: boolean): PendingInteractionRespondResult {
  return {
    resolved: true,
    needsResume,
    kind: meta.kind,
    interactionId: meta.approvalId,
    rootRunId: meta.rootRunId,
    approvalId: meta.approvalId,
    toolCallId: meta.toolCallId,
  };
}

function normalizeInputType(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized === "select" ? "select" : "text";
}

function normalizeInteractionKind(payload: InteractionResponsePayload): InteractionKind {
  if (payload.kind === "approval" || payload.kind === "user_input") {
    return payload.kind;
  }
  return typeof payload.approved === "boolean" ? "approval" : "user_input";
}

function metaFromRecord(record: PendingInteractionRecord): ApprovalMeta {
  const payload = record.request_payload;
  return {
    approvalId: record.interaction_id,
    sessionId: record.session_id,
    toolCallId: record.tool_call_id,
    rootRunId: record.root_run_id,
    runId: record.run_id,
    kind: record.kind,
    batchId: record.batch_id,
    resolved: record.status === "resolved" || record.status === "resuming" || record.status === "consumed",
    task: typeof payload.task === "string" ? payload.task : "",
    requestId: typeof payload.requestId === "string" ? payload.requestId : null,
    ...(typeof payload.executionKind === "string" ? { executionKind: payload.executionKind } : {}),
    ...(typeof payload.botId === "string" ? { botId: payload.botId } : {}),
    ...(typeof payload.chatId === "string" ? { chatId: payload.chatId } : {}),
    ...(typeof payload.toolName === "string" ? { toolName: payload.toolName } : {}),
    ...(typeof payload.riskLevel === "string" ? { riskLevel: payload.riskLevel } : {}),
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    ...(typeof payload.prompt === "string" ? { prompt: payload.prompt } : {}),
    ...(Array.isArray(payload.options) ? { options: payload.options.filter((item): item is string => typeof item === "string") } : {}),
  };
}

function resolutionFromRecord(record: PendingInteractionRecord): ApprovalCacheResolution | null {
  const payload = record.resolution_payload;
  if (!payload) return null;
  if (record.kind === "user_input") {
    return { value: typeof payload.value === "string" ? payload.value : "" };
  }
  return {
    approved: payload.approved === true,
    message: typeof payload.message === "string" ? payload.message : "",
  };
}
