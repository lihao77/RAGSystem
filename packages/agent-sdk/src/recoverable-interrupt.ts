export type RecoverableInterruptKind = "approval" | "user_input";

export interface RecoverableInterruptContext {
  sessionId: string;
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  parentCallId: string | null;
  toolCallId: string;
  kind: RecoverableInterruptKind;
}

/** Signals that the host should suspend a run until an interaction is resolved. */
export class RecoverableInterrupt extends Error {
  readonly sessionId: string;
  readonly runId: string;
  readonly rootRunId: string;
  readonly parentRunId: string | null;
  readonly parentCallId: string | null;
  readonly toolCallId: string;
  readonly kind: RecoverableInterruptKind;

  constructor(context: RecoverableInterruptContext) {
    super(`Agent run suspended for ${context.kind}`);
    this.name = "RecoverableInterrupt";
    this.sessionId = context.sessionId;
    this.runId = context.runId;
    this.rootRunId = context.rootRunId;
    this.parentRunId = context.parentRunId;
    this.parentCallId = context.parentCallId;
    this.toolCallId = context.toolCallId;
    this.kind = context.kind;
  }
}
