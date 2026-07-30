import type { Envelope } from "../../contracts/events.js";
import type { ExecutionReadApplication } from "../../contracts/execution/execution-read-application.js";
import { EnvelopeProjector } from "../runtime/event-outbox/projector.js";

/**
 * Rebuilds the presentation stream for one active root run. Resolved historical
 * interactions are omitted; the authoritative runtime snapshot restores the
 * currently pending interaction after replay has caught up.
 */
export async function loadAguiRunReplay(
  reads: ExecutionReadApplication,
  sessionId: string,
  runId: string,
  afterSeq = 0,
): Promise<Envelope[]> {
  const projector = new EnvelopeProjector();
  const events: Envelope[] = [];
  let cursor = afterSeq;
  const pageSize = 500;
  for (;;) {
    const rows = await reads.listOutboxForReplay({
      sessionId,
      runIds: [runId],
      afterSeq: cursor,
      limit: pageSize,
    });
    if (rows.length === 0) break;
    events.push(...rows.map((row) => projector.toEnvelope(row)).filter(isAguiReplayableEvent));
    const nextCursor = rows.at(-1)?.session_seq ?? cursor;
    if (nextCursor <= cursor || rows.length < pageSize) break;
    cursor = nextCursor;
  }
  return events;
}

export function isAguiReplayableEvent(event: Envelope): boolean {
  if (event.type === "delegate_call") return false;
  if (event.type !== "interaction") return true;
  const payload = event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload as Record<string, unknown>
    : {};
  return payload.phase !== "required";
}
