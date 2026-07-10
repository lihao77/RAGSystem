import { PROTOCOL_VERSION, type Envelope } from "@ragsystem/agent-protocol";
import type { ConversationStoreTransaction } from "../../../contracts/conversation-store/index.js";

export const EXECUTION_ENVELOPE_STEP_TYPE = "protocol.envelope.v1";

const EXECUTION_ENVELOPE_TYPES = new Set<Envelope["type"]>([
  "agent_started",
  "agent_ended",
  "stream_output",
  "tool_call",
  "tool_result",
]);

export function archiveExecutionEnvelope(
  tx: ConversationStoreTransaction,
  sessionId: string,
  runId: string | null,
  envelope: Envelope,
): void {
  // Session-level events can be delivered live but are intentionally absent from run-scoped replay.
  if (!runId || !EXECUTION_ENVELOPE_TYPES.has(envelope.type)) {
    return;
  }
  tx.addRunStep({
    sessionId,
    runId,
    stepType: EXECUTION_ENVELOPE_STEP_TYPE,
    payload: {
      ...envelope,
      protocol_version: envelope.protocol_version ?? PROTOCOL_VERSION,
      session_id: sessionId,
      run_id: runId,
    },
  });
}
