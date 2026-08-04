export type TerminalFailureStatus = "failed" | "interrupted";

/** Normalizes terminal errors once for persistence, events, and API results. */
export function terminalReason(status: TerminalFailureStatus, error: unknown): string {
  const reason = error instanceof Error
    ? error.message
    : typeof error === "string" ? error : error == null ? "" : String(error);
  return (reason.trim() || (status === "failed" ? "未提供失败原因" : "未提供中断原因")).slice(0, 2_000);
}
