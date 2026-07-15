/** 可恢复中断类型。 */
export type RecoverableInterruptKind = "approval" | "user_input";

/** 可恢复中断携带的 run 树上下文。 */
export interface RecoverableInterruptContext {
  sessionId: string;
  runId: string;
  rootRunId: string;
  parentRunId: string | null;
  parentCallId: string | null;
  toolCallId: string;
  kind: RecoverableInterruptKind;
}

/**
 * 工具等待用户交互超时后抛出的可恢复中断。
 *
 * 该异常必须沿 agent 调用链静默冒泡，由宿主持久化 suspended 状态并释放运行资源。
 */
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
