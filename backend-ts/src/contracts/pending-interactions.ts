import type { ApprovalRequest, UserInputRequest } from "./execution.js";
import type { InteractionKind, InteractionResponsePayload } from "./interactions.js";

export interface PendingUserInputRequest {
  sessionId: string; runId: string; rootRunId: string; parentRunId: string | null; parentCallId: string | null;
  taskId?: string | null | undefined; requestId?: string | null | undefined; toolCallId: string; interactionBatchId?: string | undefined;
  onInteractionRequired?: ((notice: InteractionRequiredNotice) => void) | undefined; deadlineMs: number; task: string;
  executionKind?: string | undefined; botId?: string | undefined; chatId?: string | undefined; agentName?: string | null | undefined; prompt: string;
  inputType?: string | null | undefined; options?: string[] | undefined; extra?: Record<string, unknown> | undefined; signal?: AbortSignal | undefined;
}
export interface PendingUserInputResolution { inputId: string; value: string; respondedAt: string }
export interface PendingApprovalRequest {
  sessionId: string; runId: string; rootRunId: string; parentRunId: string | null; parentCallId: string | null;
  taskId?: string | null | undefined; requestId?: string | null | undefined; toolCallId: string; interactionBatchId?: string | undefined;
  onInteractionRequired?: ((notice: InteractionRequiredNotice) => void) | undefined; deadlineMs: number; task: string;
  executionKind?: string | undefined; botId?: string | undefined; chatId?: string | undefined; agentName?: string | null | undefined; approvalType?: string | null | undefined;
  toolName: string; arguments?: Record<string, unknown> | undefined; riskLevel?: string | null | undefined; description?: string | null | undefined;
  permissionMode?: string | null | undefined; approvalReason?: string | null | undefined; approvalReasonCodes?: string[] | undefined;
  approvalSecondaryReasons?: string[] | undefined; approvalHook?: Record<string, unknown> | undefined; externalPathCandidates?: string[] | undefined; signal?: AbortSignal | undefined;
}
export interface PendingApprovalResolution { approvalId: string; approved: boolean; message: string; respondedAt: string }
export interface PendingInteractionResolutionResult {
  resolved: boolean; needsResume: boolean; kind: InteractionKind; interactionId: string; rootRunId?: string | undefined;
  approvalId?: string | undefined; toolCallId?: string | undefined; approved?: boolean | undefined; message?: string | undefined; error?: string | undefined;
}
export type ApprovalCacheResolution = { approved: boolean; message: string } | { value: string };
export interface ApprovalMeta {
  approvalId: string; sessionId: string; toolCallId: string; rootRunId: string; runId: string; kind: InteractionKind;
  batchId: string; resolved: boolean; task: string; requestId: string | null; executionKind?: string | undefined; botId?: string | undefined;
  chatId?: string | undefined; toolName?: string | undefined; riskLevel?: string | undefined; reason?: string | undefined; prompt?: string | undefined; options?: string[] | undefined;
}
export interface InteractionRequiredNotice { interactionId: string; sessionId: string; rootRunId: string; batchId: string; kind: InteractionKind }
export interface PendingInteractionRespondResult {
  resolved: boolean; needsResume: boolean; kind: InteractionKind; interactionId: string; rootRunId?: string | undefined;
  approvalId?: string | undefined; toolCallId?: string | undefined;
}

export const DEFAULT_INTERACTION_DEADLINE_MS = 120_000;
export function resolveInteractionDeadlineMs(_executionKind: string | null | undefined): number {
  return DEFAULT_INTERACTION_DEADLINE_MS;
}

/** Execution-side interaction port, implemented independently by each deployment adapter. */
export interface PendingInteractionPort {
  setApprovalCache(sessionId: string, toolCallId: string, resolution: ApprovalCacheResolution): void;
  peekApprovalMeta(approvalId: string, sessionId: string): ApprovalMeta | null;
  takeApprovalMeta(approvalId: string, sessionId?: string): ApprovalMeta | null;
  releaseApprovalBatch(meta: ApprovalMeta): void;
  findLatestApprovalMeta(rootRunId: string, sessionId?: string): ApprovalMeta | null;
  listPendingApprovalMeta(rootRunId: string, sessionId?: string): ApprovalMeta[];
  finalizeRoot(sessionId: string, rootRunId: string, completed: boolean): void;
  waitForUserInput(input: PendingUserInputRequest): Promise<PendingUserInputResolution>;
  respondUserInput(sessionId: string, inputId: string, payload: UserInputRequest): PendingInteractionRespondResult;
  waitForApproval(input: PendingApprovalRequest): Promise<PendingApprovalResolution>;
  respondApproval(sessionId: string, approvalId: string, payload: ApprovalRequest): PendingInteractionRespondResult;
  respondInteraction(sessionId: string, interactionId: string, payload: InteractionResponsePayload): PendingInteractionResolutionResult;
  cancelSession(sessionId: string, reason?: string, options?: { persist?: boolean }): void;
  isUserInputPending(sessionId: string, inputId: string): boolean;
  isApprovalPending(sessionId: string, approvalId: string): boolean;
}
