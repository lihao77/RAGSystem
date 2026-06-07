import { randomUUID } from "node:crypto";

import type { ClientEvent } from "../../contracts/events.js";
import type { ApprovalRequest, UserInputRequest } from "../../contracts/execution.js";
import type { InteractionKind, InteractionResponsePayload } from "../../contracts/interactions.js";
import type { ClientEventPublisher } from "./event-outbox/client-event-publisher.js";

export interface PendingUserInputRequest {
  sessionId: string;
  runId?: string | null | undefined;
  taskId?: string | null | undefined;
  requestId?: string | null | undefined;
  toolCallId?: string | null | undefined;
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
  runId?: string | null | undefined;
  taskId?: string | null | undefined;
  requestId?: string | null | undefined;
  toolCallId?: string | null | undefined;
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
  approvedExternalPaths?: string[] | undefined;
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

  constructor(private readonly clientEvents: ClientEventPublisher) {}

  waitForUserInput(input: PendingUserInputRequest): Promise<PendingUserInputResolution> {
    const sessionId = input.sessionId.trim();
    if (!sessionId) {
      return Promise.reject(new Error("request_user_input 缺少 session_id"));
    }
    if (input.signal?.aborted) {
      return Promise.reject(new Error("request_user_input cancelled"));
    }

    const inputId = randomUUID();
    const prompt = input.prompt.trim();
    const inputType = normalizeInputType(input.inputType);
    const options = input.options ?? [];
    const extra = input.extra ?? {};

    const promise = new Promise<PendingUserInputResolution>((resolve, reject) => {
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

    const payload = {
      interaction_id: inputId,
      kind: "user_input",
      input_id: inputId,
      tool_call_id: input.toolCallId ?? null,
      tool_name: "request_user_input",
      agent_name: input.agentName ?? null,
      prompt,
      input_type: inputType,
      options,
      extra,
      run_id: input.runId ?? null,
      task_id: input.taskId ?? null,
      request_id: input.requestId ?? null,
    };
    const interactionEvent: ClientEvent = {
      type: "interaction.required",
      session_id: sessionId,
      data: payload,
      content: payload,
    };
    if (input.runId) {
      interactionEvent.run_id = input.runId;
    }
    this.publish(sessionId, interactionEvent);

    const legacyEvent: ClientEvent = {
      type: "user.input_required",
      session_id: sessionId,
      data: payload,
      content: payload,
    };
    if (input.runId) {
      legacyEvent.run_id = input.runId;
    }
    this.publish(sessionId, legacyEvent);

    return promise;
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

    const approvalId = randomUUID();
    const promise = new Promise<PendingApprovalResolution>((resolve, reject) => {
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

    const payload = {
      interaction_id: approvalId,
      kind: "approval",
      approval_id: approvalId,
      approval_type: input.approvalType ?? null,
      tool_call_id: input.toolCallId ?? null,
      tool_name: input.toolName,
      agent_name: input.agentName ?? null,
      arguments: input.arguments ?? {},
      risk_level: input.riskLevel ?? "unknown",
      description: input.description ?? "",
      permission_mode: input.permissionMode ?? null,
      approval_reason: input.approvalReason ?? "",
      approval_reason_codes: input.approvalReasonCodes ?? [],
      approval_secondary_reasons: input.approvalSecondaryReasons ?? [],
      approval_hook: input.approvalHook ?? {},
      approved_external_paths: input.approvedExternalPaths ?? [],
      run_id: input.runId ?? null,
      task_id: input.taskId ?? null,
      request_id: input.requestId ?? null,
    };
    const interactionEvent: ClientEvent = {
      type: "interaction.required",
      session_id: sessionId,
      data: payload,
      content: payload,
    };
    if (input.runId) {
      interactionEvent.run_id = input.runId;
    }
    this.publish(sessionId, interactionEvent);

    const legacyEvent: ClientEvent = {
      type: "user.approval_required",
      session_id: sessionId,
      data: payload,
      content: payload,
    };
    if (input.runId) {
      legacyEvent.run_id = input.runId;
    }
    this.publish(sessionId, legacyEvent);

    return promise;
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
  }

  isUserInputPending(sessionId: string, inputId: string): boolean {
    const entry = this.pendingInputs.get(inputId);
    return Boolean(entry && entry.sessionId === sessionId);
  }

  isApprovalPending(sessionId: string, approvalId: string): boolean {
    const entry = this.pendingApprovals.get(approvalId);
    return Boolean(entry && entry.sessionId === sessionId);
  }

  private publish(sessionId: string, event: ClientEvent): void {
    const runId = typeof event.run_id === "string" && event.run_id ? event.run_id : null;
    this.clientEvents.publish(sessionId, event, {
      runId,
      aggregateType: runId ? "run" : "session",
      aggregateId: runId ?? sessionId,
    });
  }

  private publishApprovalResolution(entry: PendingApprovalEntry, payload: { approved: boolean; message: string }): void {
    const eventPayload = {
      interaction_id: entry.approvalId,
      kind: "approval",
      approval_id: entry.approvalId,
      approved: payload.approved,
      message: payload.message,
      ...(entry.runId ? { run_id: entry.runId } : {}),
      ...(entry.taskId ? { task_id: entry.taskId } : {}),
      ...(entry.requestId ? { request_id: entry.requestId } : {}),
    };
    const event: ClientEvent = {
      type: payload.approved ? "user.approval_granted" : "user.approval_denied",
      session_id: entry.sessionId,
      approval_id: entry.approvalId,
      data: eventPayload,
      content: eventPayload,
    };
    if (entry.runId) {
      event.run_id = entry.runId;
    }
    this.publish(entry.sessionId, event);
  }
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
