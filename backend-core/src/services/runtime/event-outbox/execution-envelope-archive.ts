import { PROTOCOL_VERSION, type Envelope } from "@ragsystem/agent-protocol";
import type { AddRunStepInput } from "../../../contracts/conversation-store/index.js";
import { executionEnvelopeMessageBoundary } from "../../../contracts/storage/run-step-boundary.js";

export const EXECUTION_ENVELOPE_STEP_TYPE = "protocol.envelope.v1";

const EXECUTION_ENVELOPE_TYPES = new Set<Envelope["type"]>([
  "agent_started",
  "agent_ended",
  "run_ended",
  "model_request",
  "model_attempt_started",
  "model_attempt_failed",
  "model_attempt_completed",
  "stream_output",
  "tool_call",
  "tool_result",
  "agent_message",
]);

export function buildExecutionEnvelopeRunStep(
  sessionId: string,
  runId: string | null,
  envelope: Envelope,
  eventId: string,
): AddRunStepInput | null {
  // Session-level events can be delivered live but are intentionally absent from run-scoped replay.
  if (!runId || !EXECUTION_ENVELOPE_TYPES.has(envelope.type)) {
    return null;
  }
  return {
    sessionId,
    runId,
    eventId,
    stepType: EXECUTION_ENVELOPE_STEP_TYPE,
    ...executionEnvelopeMessageBoundary(envelope),
    payload: {
      ...envelope,
      protocol_version: envelope.protocol_version ?? PROTOCOL_VERSION,
      session_id: sessionId,
      run_id: runId,
    },
  };
}
