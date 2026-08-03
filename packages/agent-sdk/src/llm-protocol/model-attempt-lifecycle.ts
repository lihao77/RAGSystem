import type { LlmRequest } from "@ragsystem/agent-llm";
import type { EventSink } from "../contracts.js";

/** Adds physical provider-attempt events without changing preview requests. */
export function withModelAttemptLifecycle(
  request: LlmRequest,
  events: EventSink,
  agentName: string,
  round: number,
): LlmRequest {
  const provider = String(request.provider.name ?? request.provider.provider_type);
  const previous = request.onAttemptLifecycle;
  return {
    ...request,
    onAttemptLifecycle: (event) => {
      previous?.(event);
      const base = {
        agentName,
        round,
        attemptId: event.attemptId,
        attempt: event.attempt,
        maxAttempts: event.maxAttempts,
        provider,
        model: request.model,
      };
      if (event.phase === "started") {
        events.emit({ type: "model_attempt_started", ...base });
      } else if (event.phase === "failed") {
        events.emit({
          type: "model_attempt_failed",
          ...base,
          willRetry: event.willRetry,
          ...(event.retryDelayMs !== undefined ? { retryDelayMs: event.retryDelayMs } : {}),
          elapsedMs: event.elapsedMs,
          error: event.error,
        });
      } else {
        events.emit({ type: "model_attempt_completed", ...base, elapsedMs: event.elapsedMs });
      }
    },
  };
}
