import type { Envelope } from "../../../contracts/events.js";
import type { OutboxRow } from "../../../contracts/conversation-store/index.js";

/**
 * Outbox 行 → Envelope 还原器。
 *
 * 所有产出方（实时 event-publisher + 终态 recorder）一律写 `client.{envelope_type}` 行，
 * payload.client_event 存完整 Envelope。还原时以持久化权威值（row.event_id / row.session_seq）
 * 盖 message_id / seq——它们是去重键与连续性游标，须以落库序为准，不信任产出方临时值。
 */
export class EnvelopeProjector {
  toEnvelope(row: OutboxRow): Envelope {
    const payload = parsePayload(row);
    const event = asEnvelope(payload.client_event);
    return {
      ...event,
      session_id: row.session_id,
      ...(row.run_id ? { run_id: row.run_id } : {}),
      message_id: row.event_id,
      seq: row.session_seq,
    };
  }
}

function asEnvelope(value: unknown): Envelope {
  const event = asRecord(value);
  const type = asString(event.type);
  if (!type) {
    throw new Error("client event payload is missing type");
  }
  const { message_id: _messageId, seq: _seq, ...rest } = event;
  return { ...rest, type } as Envelope;
}

function parsePayload(row: OutboxRow): Record<string, unknown> {
  try {
    return asRecord(JSON.parse(row.payload));
  } catch (error) {
    throw new Error(`Invalid outbox payload ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
