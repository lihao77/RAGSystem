import type { Envelope } from "@ragsystem/agent-protocol";

export type RunStepMessageBoundary = {
  boundaryMessageId: string;
  boundaryKind: "carrier" | "terminal";
};

export function executionEnvelopeMessageBoundary(
  envelope: Envelope,
): RunStepMessageBoundary | Record<string, never> {
  // boundary_message_id targets live rendering; only canonical messages split durable step ranges.
  const messageId = envelopeMessageId(envelope);
  if (!messageId) return {};
  if (envelope.type === "agent_message") {
    return { boundaryMessageId: messageId, boundaryKind: "carrier" };
  }
  const payload = envelope.payload as Record<string, unknown> | undefined;
  if (envelope.type === "stream_output" && payload?.phase === "final") {
    return { boundaryMessageId: messageId, boundaryKind: "terminal" };
  }
  return {};
}

function envelopeMessageId(envelope: Envelope): string | null {
  if (typeof envelope.message_id === "string" && envelope.message_id.trim()) {
    return envelope.message_id.trim();
  }
  const payload = envelope.payload as Record<string, unknown> | undefined;
  const ref = payload?.ref as Record<string, unknown> | undefined;
  const value = payload?.message_id ?? ref?.message_id;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
