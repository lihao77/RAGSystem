import { randomUUID } from "node:crypto";

import { RecoverableInterrupt } from "@ragsystem/agent-protocol";
import type { Envelope } from "../../contracts/events.js";
import type { ApprovalRequest, UserInputRequest } from "../../contracts/execution.js";
import type { InteractionKind, InteractionResponsePayload } from "../../contracts/interactions.js";
import type { ClientEventPublisher } from "./event-outbox/client-event-publisher.js";

export interface PendingUserInputRequest {
  sessionId: string;
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  parentCallId: string | null;
  taskId?: string | null | undefined;
  requestId?: string | null | undefined;
  toolCallId: string;
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
  task: string;
  requestId: string | null;
  executionKind?: string | undefined;
  botId?: string | undefined;
  chatId?: string | undefined;
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

export const DEFAULT_INTERACTION_DEADLINE_MS = 120_000;

/** daemon 类 run 不占用 lease 等待交互，其余对话 run 默认等待两分钟。 */
export function resolveInteractionDeadlineMs(executionKind: string | null | undefined): number {
  return executionKind?.startsWith("daemon") ? 0 : DEFAULT_INTERACTION_DEADLINE_MS;
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

export class PendingInteractionService {
  private readonly pendingInputs = new Map<string, PendingInputEntry>();
  private readonly pendingApprovals = new Map<string, PendingApprovalEntry>();
  private readonly approvalCache = new Map<string, ApprovalCacheResolution>();
  private readonly approvalMeta = new Map<string, ApprovalMeta>();

  constructor(private readonly clientEvents: ClientEventPublisher) {}

  /** 恢复入口写入已完成的审批/输入结果；工具按 session+toolCallId 消费一次。 */
  setApprovalCache(sessionId: string, toolCallId: string, resolution: ApprovalCacheResolution): void {
    this.approvalCache.set(cacheKey(sessionId, toolCallId), resolution);
  }

  /** 恢复执行器消费一次挂起凭证。 */
  takeApprovalMeta(approvalId: string): ApprovalMeta | null {
    const meta = this.approvalMeta.get(approvalId) ?? null;
    if (meta) {
      this.approvalMeta.delete(approvalId);
    }
    return meta;
  }

  /** 查询同一 root 最新生成的挂起凭证，供续跑中再次挂起回调。 */
  findLatestApprovalMeta(rootRunId: string): ApprovalMeta | null {
    const matches = Array.from(this.approvalMeta.values()).filter((meta) => meta.rootRunId === rootRunId);
    return matches.at(-1) ?? null;
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

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<PendingUserInputResolution>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        this.approvalMeta.set(inputId, buildApprovalMeta(inputId, sessionId, "user_input", input));
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
      entry.abortListener?.();
      this.publishUserInputResolution(entry, value);
      entry.resolve({
        inputId,
        value,
        respondedAt: new Date().toISOString(),
      });
      return { resolved: true, needsResume: false, kind: "user_input", interactionId: inputId };
    }
    const meta = this.approvalMeta.get(inputId);
    if (!meta || meta.sessionId !== sessionId || meta.kind !== "user_input") {
      return { resolved: false, needsResume: false, kind: "user_input", interactionId: inputId };
    }
    this.setApprovalCache(sessionId, meta.toolCallId, { value });
    this.publishUserInputResolution(meta, value);
    return resumeResult(meta);
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

    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeoutPromise = new Promise<PendingApprovalResolution>((_resolve, reject) => {
      timeoutHandle = setTimeout(() => {
        this.approvalMeta.set(approvalId, buildApprovalMeta(approvalId, sessionId, "approval", input));
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
    const meta = this.approvalMeta.get(approvalId);
    if (!meta || meta.sessionId !== sessionId || meta.kind !== "approval") {
      return { resolved: false, needsResume: false, kind: "approval", interactionId: approvalId };
    }
    this.setApprovalCache(sessionId, meta.toolCallId, { approved, message });
    this.publishApprovalResolution(meta, { approved, message });
    return resumeResult(meta);
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

  cancelSession(sessionId: string, reason = "request_user_input cancelled"): void {
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
    }
    return resolution;
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
    task: input.task,
    requestId: input.requestId ?? null,
    ...(input.executionKind ? { executionKind: input.executionKind } : {}),
    ...(input.botId ? { botId: input.botId } : {}),
    ...(input.chatId ? { chatId: input.chatId } : {}),
  };
}

function resumeResult(meta: ApprovalMeta): PendingInteractionRespondResult {
  return {
    resolved: true,
    needsResume: true,
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
