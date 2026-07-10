import type { ToolExecContext } from "@ragsystem/agent-sdk";

export function toolContext(overrides: Partial<ToolExecContext> = {}): ToolExecContext {
  return {
    sessionId: null,
    runId: null,
    taskId: null,
    requestId: null,
    parentCallId: null,
    toolCallId: null,
    round: null,
    order: null,
    roundIndex: null,
    ...overrides,
  };
}
