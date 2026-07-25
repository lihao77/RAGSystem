/**
 * Envelope 投递游标与去重规则。
 *
 * 传输层只依赖顶层 seq 和 heartbeat.payload.last_seq，不需要理解具体业务 payload。
 * 前端、Widget、Node adapter 应复用这里，避免各自维护略有差异的 reconnect 边界。
 */
export interface EnvelopeCursorLike {
  type?: unknown;
  seq?: unknown;
  payload?: unknown;
}

export function normalizeEnvelopeSeq(value: unknown): number | null {
  const seq = Number(value);
  return Number.isSafeInteger(seq) && seq > 0 ? seq : null;
}

export function getEnvelopeEventSeq(envelope: EnvelopeCursorLike): number | null {
  return normalizeEnvelopeSeq(envelope.seq);
}

export function getEnvelopeCursorSeq(envelope: EnvelopeCursorLike): number | null {
  const eventSeq = getEnvelopeEventSeq(envelope);
  if (eventSeq !== null) return eventSeq;
  if (envelope.type !== "heartbeat" || !isRecord(envelope.payload)) return null;
  return normalizeEnvelopeSeq(envelope.payload.last_seq);
}

/** 单 session 的 durable Envelope 游标。无 seq 的控制帧仍会被投递。 */
export class EnvelopeDeliveryCursor {
  private lastEventSeq = 0;

  get lastSeq(): number {
    return this.lastEventSeq;
  }

  reset(): void {
    this.lastEventSeq = 0;
  }

  /**
   * 更新 durable cursor，并判断当前 Envelope 是否应交给上层。
   * 带 seq 的重复/倒序事件被丢弃；heartbeat 只校准 cursor，不因旧 cursor 被丢弃。
   */
  accept(envelope: EnvelopeCursorLike): boolean {
    const eventSeq = getEnvelopeEventSeq(envelope);
    if (eventSeq !== null) {
      if (eventSeq <= this.lastEventSeq) return false;
      this.lastEventSeq = eventSeq;
      return true;
    }

    const cursorSeq = getEnvelopeCursorSeq(envelope);
    if (cursorSeq !== null && cursorSeq > this.lastEventSeq) {
      this.lastEventSeq = cursorSeq;
    }
    return true;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
