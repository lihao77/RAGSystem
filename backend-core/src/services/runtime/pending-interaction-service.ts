import { randomUUID } from "node:crypto";

import { RecoverableInterrupt } from "@ragsystem/agent-sdk";
import type { Envelope } from "../../contracts/events.js";
import type { ApprovalRequest, UserInputRequest } from "../../contracts/execution/execution.js";
import type { InteractionKind } from "../../contracts/interactions.js";
import type { PendingInteractionRecord } from "../../contracts/conversation-store/index.js";
import type {
  ApprovalCacheResolution,
  ApprovalMeta,
  InteractionCoordinator,
  InteractionRequiredNotice,
  InteractionResumeCallbacks,
  InteractionResumeStarter,
  PendingApprovalRequest,
  PendingApprovalResolution,
  PendingInteractionRespondResult,
  PendingUserInputRequest,
  PendingUserInputResolution,
} from "../../contracts/runtime/pending-interactions.js";
import { RuntimeInteractionUnavailableError, type RuntimeFinalizeStatus, type RuntimeInteractionResolution, type RuntimeStorage } from "../../contracts/storage/runtime-storage.js";
import type { ClientEventPublisherPort } from "../../contracts/runtime/core-runtime-ports.js";
import { buildExecutionEnvelopeRunStep } from "./event-outbox/execution-envelope-archive.js";

const RESUME_LEASE_MS = 120_000;

interface LiveInteractionWaiter {
  sessionId: string;
  meta: ApprovalMeta;
  resolve(value: PendingUserInputResolution | PendingApprovalResolution): void;
  reject(error: Error): void;
  abort?: () => void;
}

/** Tenant-level async interaction coordinator backed by RuntimeStorage. */
export class RuntimeInteractionCoordinator implements InteractionCoordinator {
  private readonly liveWaiters = new Map<string, LiveInteractionWaiter>();
  private readonly resolutionCache = new Map<string, ApprovalCacheResolution>();
  private readonly pendingMeta = new Map<string, ApprovalMeta>();
  private readonly deferredResume = new Map<string, Set<string>>();
  private readonly deferredCallbacks = new Map<string, InteractionResumeCallbacks | undefined>();
  private resumeStarter: InteractionResumeStarter | undefined;

  constructor(
    readonly runtimeStorage: RuntimeStorage,
    private readonly publisher: ClientEventPublisherPort,
  ) {}

  bindResumeStarter(starter: InteractionResumeStarter): void { this.resumeStarter = starter; }

  private setApprovalCache(sessionId: string, toolCallId: string, resolution: ApprovalCacheResolution): void {
    this.resolutionCache.set(cacheKey(sessionId, toolCallId), resolution);
  }
  peekApprovalMeta(approvalId: string, sessionId: string): ApprovalMeta | null {
    const local = this.pendingMeta.get(approvalId);
    if (local && local.sessionId === sessionId) return local;
    return null;
  }
  private findLatestApprovalMeta(rootRunId: string, sessionId?: string): ApprovalMeta | null {
    return Array.from(this.pendingMeta.values()).reverse().find((m) => m.rootRunId === rootRunId && (!sessionId || m.sessionId === sessionId) && !m.resolved) ?? null;
  }
  listPendingApprovalMeta(rootRunId: string, sessionId?: string): ApprovalMeta[] {
    return Array.from(this.pendingMeta.values()).filter((m) => m.rootRunId === rootRunId && (!sessionId || m.sessionId === sessionId) && !m.resolved);
  }

  async waitForUserInput(input: PendingUserInputRequest): Promise<PendingUserInputResolution> {
    if (!input.sessionId.trim()) throw new Error("request_user_input 缺少 session_id");
    if (input.signal?.aborted) throw new Error("request_user_input cancelled");
    const cached = this.takeCached(input.sessionId, input.toolCallId, "user_input");
    if (cached && "value" in cached) return { inputId: randomUUID(), value: cached.value, respondedAt: new Date().toISOString() };
    const interactionId = randomUUID();
    const meta = this.buildMeta(interactionId, "user_input", input);
    const event: Envelope = {
      type: "interaction",
      session_id: input.sessionId,
      call_id: interactionId,
      run_id: input.runId,
      payload: {
        kind: "user_input",
        phase: "required",
        tool: "request_user_input",
        prompt: input.prompt,
        input: {
          input_type: normalizeInputType(input.inputType),
          options: input.options ?? [],
          extra: input.extra ?? {},
          tool_call_id: input.toolCallId,
          agent_name: input.agentName ?? null,
        },
      },
    };
    const pending = this.waitLive(interactionId, input, meta, "user_input");
    try { await this.recordRequired(meta, input, event); } catch (error) { const waiter = this.liveWaiters.get(interactionId); this.liveWaiters.delete(interactionId); this.pendingMeta.delete(interactionId); waiter?.abort?.(); waiter?.reject(error instanceof Error ? error : new Error(String(error))); return pending; }
    return pending;
  }

  async waitForApproval(input: PendingApprovalRequest): Promise<PendingApprovalResolution> {
    if (!input.sessionId.trim()) throw new Error("approval 缺少 session_id");
    if (input.signal?.aborted) throw new Error("approval cancelled");
    const cached = this.takeCached(input.sessionId, input.toolCallId, "approval");
    if (cached && "approved" in cached) return { approvalId: randomUUID(), approved: cached.approved, message: cached.message, respondedAt: new Date().toISOString() };
    const interactionId = randomUUID();
    const meta = this.buildMeta(interactionId, "approval", input);
    const event: Envelope = {
      type: "interaction",
      session_id: input.sessionId,
      call_id: interactionId,
      run_id: input.runId,
      payload: {
        kind: "approval",
        phase: "required",
        tool: input.toolName,
        risk_level: input.riskLevel === "low" || input.riskLevel === "medium" || input.riskLevel === "high" ? input.riskLevel : undefined,
        prompt: input.description ?? "",
        input: {
          approval_id: interactionId,
          approval_type: input.approvalType ?? null,
          tool_call_id: input.toolCallId,
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
    const pending = this.waitLive(interactionId, input, meta, "approval");
    try { await this.recordRequired(meta, input, event); } catch (error) { const waiter = this.liveWaiters.get(interactionId); this.liveWaiters.delete(interactionId); this.pendingMeta.delete(interactionId); waiter?.abort?.(); waiter?.reject(error instanceof Error ? error : new Error(String(error))); return pending; }
    return pending;
  }

  private async recordRequired(meta: ApprovalMeta, input: PendingApprovalRequest | PendingUserInputRequest, event: Envelope): Promise<void> {
    this.pendingMeta.set(meta.approvalId, meta);
    const prompt = "prompt" in input ? input.prompt : undefined;
    const requestPayload = {
      ...meta,
      ...(input.lineageParentCallId !== undefined ? { lineageParentCallId: input.lineageParentCallId } : {}),
      ...(input.workspaceRoot !== undefined ? { workspaceRoot: input.workspaceRoot } : {}),
      interaction_payload: event.payload,
      ...(prompt !== undefined ? { prompt } : {}),
      ...("toolName" in input ? {
        toolName: input.toolName,
        approvalType: input.approvalType ?? null,
        arguments: input.arguments ?? {},
        permissionMode: input.permissionMode ?? null,
        approvalReasonCodes: input.approvalReasonCodes ?? [],
        approvalSecondaryReasons: input.approvalSecondaryReasons ?? [],
        approvalHook: input.approvalHook ?? {},
        externalPathCandidates: input.externalPathCandidates ?? [],
      } : {}),
    };
    const record = await this.runtimeStorage.operations.recordInteraction({
      interaction: { interactionId: meta.approvalId, sessionId: meta.sessionId, runId: meta.runId, rootRunId: meta.rootRunId, toolCallId: meta.toolCallId, batchId: meta.batchId, kind: meta.kind, requestPayload },
      rootCallId: input.rootCallId?.trim() || `call_${meta.rootRunId}`,
      record: this.eventRecord(meta.sessionId, event, `${meta.approvalId}:required`),
    });
    await this.publisher.deliver([record.record.outbox]);
    input.onInteractionRequired?.({ interactionId: meta.approvalId, sessionId: meta.sessionId, rootRunId: meta.rootRunId, batchId: meta.batchId, kind: meta.kind });
  }

  private waitLive<T extends "approval" | "user_input">(id: string, input: PendingApprovalRequest | PendingUserInputRequest, meta: ApprovalMeta, kind: T): Promise<T extends "approval" ? PendingApprovalResolution : PendingUserInputResolution> {
    if (input.signal?.aborted) return Promise.reject(new Error(`${kind} cancelled`));
    return new Promise((resolve, reject) => {
      const waiter: LiveInteractionWaiter = { sessionId: meta.sessionId, meta, resolve: resolve as any, reject };
      const timer = setTimeout(() => { this.liveWaiters.delete(id); waiter.abort?.(); reject(new RecoverableInterrupt({ sessionId: input.sessionId, runId: input.runId, rootRunId: input.rootRunId, parentRunId: input.parentRunId, parentCallId: input.parentCallId, toolCallId: input.toolCallId, kind })); }, Math.max(0, input.deadlineMs));
      const abort = (): void => { clearTimeout(timer); this.liveWaiters.delete(id); reject(new Error(`${kind} cancelled`)); };
      waiter.abort = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", abort); };
      input.signal?.addEventListener("abort", abort, { once: true });
      this.liveWaiters.set(id, waiter);
    }) as any;
  }

  async respondApprovalAsync(sessionId: string, approvalId: string, payload: ApprovalRequest, callbacks?: InteractionResumeCallbacks): Promise<PendingInteractionRespondResult> {
    return this.respondAsync(sessionId, approvalId, { kind: "approval", approved: Boolean(payload.approved), message: payload.message ?? "" }, callbacks);
  }
  async respondUserInputAsync(sessionId: string, inputId: string, payload: UserInputRequest, callbacks?: InteractionResumeCallbacks): Promise<PendingInteractionRespondResult> {
    return this.respondAsync(sessionId, inputId, { kind: "user_input", value: payload.value ?? "" }, callbacks);
  }
  async resumeAsync(sessionId: string, interactionId: string): Promise<"none" | "started" | "deferred" | "already_started"> {
    return this.tryResume(sessionId, interactionId);
  }
  private async respondAsync(sessionId: string, interactionId: string, resolution: RuntimeInteractionResolution, callbacks?: InteractionResumeCallbacks): Promise<PendingInteractionRespondResult> {
    let result;
    try {
      result = await this.runtimeStorage.operations.resolveInteraction({ sessionId, interactionId, resolution, buildRecord: (interaction) => this.eventRecord(sessionId, { type: "interaction", session_id: sessionId, call_id: interactionId, run_id: interaction.run_id, payload: resolution.kind === "approval" ? { kind: "approval", phase: "responded", approved: resolution.approved, message: resolution.message } : { kind: "user_input", phase: "responded", value: resolution.value } }, `${interactionId}:responded`) });
    } catch (error) {
      if (error instanceof RuntimeInteractionUnavailableError) {
        return { resolved: false, needsResume: false, kind: resolution.kind, interactionId };
      }
      throw error;
    }
    await this.publisher.deliver([result.record.outbox]);
    const meta = this.pendingMeta.get(interactionId) ?? metaFromRecord(result.interaction);
    meta.resolved = true;
    this.pendingMeta.set(interactionId, meta);
    if (!result.changed) {
      const alreadyResolved = ["resolved", "resuming", "consumed"].includes(result.previousStatus);
      const shouldResume = result.previousStatus === "resolved" && result.batchReady;
      const resumeDisposition = shouldResume
        ? await this.tryResume(sessionId, interactionId, callbacks)
        : "none" as const;
      return {
        resolved: alreadyResolved,
        needsResume: resumeDisposition !== "none",
        kind: resolution.kind,
        interactionId,
        rootRunId: meta.rootRunId,
        toolCallId: meta.toolCallId,
        resumeDisposition,
      };
    }
    const waiter = this.liveWaiters.get(interactionId);
    if (waiter) { this.liveWaiters.delete(interactionId); waiter.abort?.(); waiter.resolve(resolution.kind === "approval" ? { approvalId: interactionId, approved: resolution.approved, message: resolution.message, respondedAt: new Date().toISOString() } : { inputId: interactionId, value: resolution.value, respondedAt: new Date().toISOString() }); return { resolved: true, needsResume: false, kind: resolution.kind, interactionId, rootRunId: meta.rootRunId, toolCallId: meta.toolCallId }; }
    const resumeDisposition = result.batchReady
      ? await this.tryResume(sessionId, interactionId, callbacks)
      : "none" as const;
    return {
      resolved: true,
      needsResume: resumeDisposition !== "none",
      kind: resolution.kind,
      interactionId,
      rootRunId: meta.rootRunId,
      toolCallId: meta.toolCallId,
      resumeDisposition,
    };
  }

  private async tryResume(sessionId: string, interactionId: string, callbacks?: InteractionResumeCallbacks): Promise<"none" | "started" | "deferred" | "already_started"> {
    if (!this.resumeStarter) return "none";
    const recovered = await this.runtimeStorage.operations.recoverExpiredResumeClaims({ sessionId });
    if (recovered.recoveredClaimIds.length > 0 || recovered.suspendedRootRunIds.length > 0) {
      await this.publishRuntimeInvalidation(sessionId, "resume_claim_recovered");
    }
    const claim = await this.runtimeStorage.operations.claimResume({
      sessionId,
      interactionId,
      claimId: randomUUID(),
      leaseMs: RESUME_LEASE_MS,
    });
    if (!claim.claimed) {
      if (claim.reason === "root_not_suspended") {
        const rootRunId = this.pendingMeta.get(interactionId)?.rootRunId;
        if (rootRunId) {
          const key = `${sessionId}:${rootRunId}`;
          const current = this.deferredResume.get(key) ?? new Set<string>();
          current.add(interactionId);
          this.deferredResume.set(key, current);
          this.deferredCallbacks.set(`${key}:${interactionId}`, callbacks);
        }
        return "deferred";
      }
      if (claim.reason === "already_claimed") return "already_started";
      return "none";
    }
    // resuming 只覆盖 durable claim 到执行器注册的短窗口；通知失败不能阻断后续 attach。
    void this.publishRuntimeInvalidation(sessionId, "resume_claimed").catch(() => undefined);
    for (const item of claim.resolutions) this.setApprovalCache(sessionId, item.toolCallId, item.resolution.kind === "approval" ? { approved: item.resolution.approved, message: item.resolution.message } : { value: item.resolution.value });
    const attached = await this.runtimeStorage.operations.attachResume({
        sessionId,
        rootRunId: claim.rootRunId,
        claimId: claim.claimId,
        batchId: claim.batchId,
        record: this.eventRecord(sessionId, {
          type: "state_sync",
          session_id: sessionId,
          run_id: claim.rootRunId,
          payload: {
            category: "session_updated",
            detail: { entity: "session_runtime", reason: "resume_executor_attached" },
          },
        }, `${claim.claimId}:resume_executor_attached`),
    });
    if (!attached.attached || !attached.record) {
      for (const item of claim.resolutions) this.resolutionCache.delete(cacheKey(sessionId, item.toolCallId));
      await this.runtimeStorage.operations.rollbackResume({
        sessionId,
        rootRunId: claim.rootRunId,
        claimId: claim.claimId,
        batchId: claim.batchId,
      });
      throw new Error(`resume executor attach claim was lost: ${claim.claimId}`);
    }
    void this.publisher.deliver([attached.record.outbox]).catch(() => undefined);
    let started: ReturnType<InteractionResumeStarter["startClaim"]>;
    try {
      started = this.resumeStarter.startClaim({ sessionId, claim });
    } catch (error) {
      for (const item of claim.resolutions) this.resolutionCache.delete(cacheKey(sessionId, item.toolCallId));
      await this.runtimeStorage.operations.rollbackResume({
        sessionId,
        rootRunId: claim.rootRunId,
        claimId: claim.claimId,
        batchId: claim.batchId,
      });
      await this.publishRuntimeInvalidation(sessionId, "resume_start_failed");
      throw error;
    }
    void started.promise.then((result) => {
      if (result.suspended) {
        callbacks?.onSuspended?.(this.findLatestApprovalMeta(claim.rootRunId, sessionId)?.approvalId ?? "");
        return;
      }
      callbacks?.onCompleted?.({ content: result.content, success: result.success });
    }).catch((error: unknown) => callbacks?.onCompleted?.({
      content: error instanceof Error ? error.message : String(error),
      success: false,
    }));
    return "started";
  }
  async onRootFinalized(sessionId: string, rootRunId: string, status: RuntimeFinalizeStatus, readyResumeInteractionIds: string[] = []): Promise<void> {
    const deferredKey = `${sessionId}:${rootRunId}`;
    const retryIds = new Set([...readyResumeInteractionIds, ...(this.deferredResume.get(deferredKey) ?? [])]);
    this.deferredResume.delete(deferredKey);
    if (status !== "suspended") {
      for (const id of retryIds) this.deferredCallbacks.delete(`${deferredKey}:${id}`);
    }
    for (const [id, waiter] of this.liveWaiters) if (waiter.sessionId === sessionId && waiter.meta.rootRunId === rootRunId) { this.liveWaiters.delete(id); waiter.abort?.(); waiter.reject(new Error(`interaction root finalized: ${status}`)); }
    for (const [id, meta] of this.pendingMeta) {
      if (meta.sessionId !== sessionId || meta.rootRunId !== rootRunId) continue;
      if (status === "suspended" && !meta.resolved) continue;
      this.pendingMeta.delete(id);
      this.resolutionCache.delete(cacheKey(sessionId, meta.toolCallId));
    }
    if (status === "suspended") {
      for (const id of retryIds) {
        const callbackKey = `${deferredKey}:${id}`;
        const callbacks = this.deferredCallbacks.get(callbackKey);
        this.deferredCallbacks.delete(callbackKey);
        await this.tryResume(sessionId, id, callbacks);
      }
    }
  }
  async listPendingAsync(rootRunId: string, sessionId?: string): Promise<ApprovalMeta[]> {
    const sid = sessionId ?? Array.from(this.pendingMeta.values()).find((m) => m.rootRunId === rootRunId)?.sessionId;
    if (!sid) return [];
    return this.listPendingApprovalMeta(rootRunId, sid);
  }
  async cancelSession(sessionId: string, reason = "interaction cancelled"): Promise<void> {
    for (const [id, waiter] of this.liveWaiters) {
      if (waiter.sessionId !== sessionId) continue;
      this.liveWaiters.delete(id);
      waiter.abort?.();
      waiter.reject(new Error(reason));
    }
    for (const [id, meta] of this.pendingMeta) {
      if (meta.sessionId === sessionId) this.pendingMeta.delete(id);
    }
    const prefix = `${sessionId}:`;
    for (const key of this.resolutionCache.keys()) if (key.startsWith(prefix)) this.resolutionCache.delete(key);
    for (const key of this.deferredResume.keys()) if (key.startsWith(prefix)) this.deferredResume.delete(key);
    for (const key of this.deferredCallbacks.keys()) if (key.startsWith(prefix)) this.deferredCallbacks.delete(key);
  }
  isUserInputPending(sessionId: string, inputId: string): boolean { const w = this.liveWaiters.get(inputId); return Boolean(w && w.sessionId === sessionId && w.meta.kind === "user_input"); }
  isApprovalPending(sessionId: string, approvalId: string): boolean { const w = this.liveWaiters.get(approvalId); return Boolean(w && w.sessionId === sessionId && w.meta.kind === "approval"); }
  private buildMeta(id: string, kind: InteractionKind, input: PendingApprovalRequest | PendingUserInputRequest): ApprovalMeta {
    const meta = buildApprovalMeta(id, input.sessionId, kind, input);
    return { ...meta, batchId: `${input.rootRunId}:${input.interactionBatchId?.trim() || input.toolCallId}` };
  }
  private takeCached(sessionId: string, toolCallId: string, kind: InteractionKind): ApprovalCacheResolution | null { const value = this.resolutionCache.get(cacheKey(sessionId, toolCallId)); if (value && ((kind === "approval" && "approved" in value) || (kind === "user_input" && "value" in value))) { this.resolutionCache.delete(cacheKey(sessionId, toolCallId)); return value; } return null; }
  private eventRecord(sessionId: string, event: Envelope, eventId: string) { const runId = event.run_id ?? null; return { step: buildExecutionEnvelopeRunStep(sessionId, runId, event, eventId), outbox: { sessionId, runId, eventId, eventType: `client.${event.type}`, aggregateType: runId ? "run" : "session", aggregateId: runId ?? sessionId, payload: { client_event: event } } }; }
  private publishRuntimeInvalidation(sessionId: string, reason: string): Promise<unknown> {
    return this.publisher.publish(sessionId, {
      type: "state_sync",
      session_id: sessionId,
      payload: { category: "session_updated", detail: { entity: "session_runtime", reason } },
    }, { aggregateType: "session", aggregateId: sessionId });
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

function normalizeInputType(value: string | null | undefined): string {
  const normalized = value?.trim();
  return normalized === "select" ? "select" : "text";
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
