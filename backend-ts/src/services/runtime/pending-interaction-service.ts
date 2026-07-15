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
  kind: InteractionKind;
  interactionId: string;
  approved?: boolean | undefined;
  message?: string | undefined;
  error?: string | undefined;
}

export type ApprovalCacheResolution =
  | { approved: boolean; message: string }
  | { value: string };

export const DEFAULT_INTERACTION_DEADLINE_MS = 120_000;

/** daemon 类 run 不占用 lease 等待交互，其余对话 run 默认等待两分钟。 */
export function resolveInteractionDeadlineMs(executionKind: string | null | undefined): number {
  return executionKind?.startsWith("daemon") ? 0 : DEFAULT_INTERACTION_DEADLINE_MS;
}

interface PendingInputEntry {
  sessionId: string;
  inputId: string;
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

  constructor(private readonly clientEvents: ClientEventPublisher) {}

  /** 恢复入口写入已完成的审批/输入结果；工具按 session+toolCallId 消费一次。 */
  setApprovalCache(sessionId: string, toolCallId: string, resolution: ApprovalCacheResolution): void {
    this.approvalCache.set(cacheKey(sessionId, toolCallId), resolution);
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

  respondUserInput(sessionId: string, inputId: string, payload: UserInputRequest): boolean {
    const entry = this.pendingInputs.get(inputId);
    if (!entry || entry.sessionId !== sessionId) {
      return false;
    }
    this.pendingInputs.delete(inputId);
    entry.abortListener?.();
    entry.resolve({
      inputId,
      value: payload.value ?? "",
      respondedAt: new Date().toISOString(),
    });
    return true;
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

  respondApproval(sessionId: string, approvalId: string, payload: ApprovalRequest): boolean {
    const entry = this.pendingApprovals.get(approvalId);
    if (!entry || entry.sessionId !== sessionId) {
      return false;
    }
    this.pendingApprovals.delete(approvalId);
    entry.abortListener?.();
    const approved = Boolean(payload.approved);
    const message = payload.message ?? "";
    this.publishApprovalResolution(entry, { approved, message });
    entry.resolve({
      approvalId,
      approved,
      message,
      respondedAt: new Date().toISOString(),
    });
    return true;
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
      const resolved = this.respondApproval(sessionId, interactionId, { approved, message });
      return {
        resolved,
        kind,
        interactionId,
        approved,
        message,
        ...(resolved ? {} : { error: "未找到对应的审批请求，可能已被取消或不存在" }),
      };
    }

    const resolved = this.respondUserInput(sessionId, interactionId, { value: payload.value ?? "" });
    return {
      resolved,
      kind,
      interactionId,
      ...(resolved ? {} : { error: "未找到对应的输入请求，可能已被取消或不存在" }),
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

  private publishApprovalResolution(entry: PendingApprovalEntry, payload: { approved: boolean; message: string }): void {
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
