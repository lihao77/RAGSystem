import { EventEmitter } from "node:events";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSessionWebSocketRoute } from "../src/routes/agent/ws.js";
import type { Envelope } from "../src/contracts/events.js";

const idle = { state: "idle", load_strategy: "history", allowed_actions: ["send_message", "start_maintenance"],
  active_run: null, last_run: null, pending_interactions: [], resume_interaction_id: null, maintenance: null,
  observed_at: "2026-10-10T00:00:00Z" };

afterEach(() => vi.useRealTimers());

async function harness() {
  let handler!: (socket: unknown, request: unknown) => Promise<void>;
  let listener!: (event: Envelope) => void;
  let watermark = 10;
  const rows: Array<Record<string, unknown>> = [];
  const sent: Envelope[] = [];
  const socket = Object.assign(new EventEmitter(), { readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data) as Envelope), close: vi.fn() });
  const release = vi.fn();
  const unsubscribe = vi.fn();
  const getRecoverySnapshot = vi.fn(async () => ({ event_watermark: 10, runtime: { ...idle, event_watermark: 10 },
    messages: { items: [], has_more: false, before_seq: null }, participants: [], pending_requests: [], execution: [], tree: { root: null } }));
  const read = { getSessionOutboxWatermark: async () => watermark,
    listOutboxForReplay: vi.fn(async ({ afterSeq = 0 }: { afterSeq?: number }) => rows.filter(row => Number(row.session_seq) > afterSeq)) };
  const request = { params: { sessionId: "session-1" }, query: { recovery_snapshot: "1", after_seq: "2" },
    identity: { tenantId: "tnt_test", userId: "usr_test" },
    tenantRuntimeLease: { tenantId: "tnt_test", release }, log: { error: vi.fn() },
    applications: { sessions: { getSession: async () => ({ tenant_id: "tnt_test", owner_user_id: "usr_test", visibility: "private" }) }, executionRead: read },
    container: { sessionRuntime: { getRecoverySnapshot, getSnapshot: async () => ({ ...idle, event_watermark: watermark }) },
      realtimeEvents: { subscribe: (_id: string, callback: typeof listener) => { listener = callback; return unsubscribe; } } } };
  await registerSessionWebSocketRoute({ get: (_path: unknown, _options: unknown, callback: typeof handler) => { handler = callback; } } as unknown as FastifyInstance,
    { registry: { trackWebSocket: () => ({ release: vi.fn() }) } } as unknown as Parameters<typeof registerSessionWebSocketRoute>[1]);
  const add = (seq: number) => {
    watermark = seq;
    const event = { type: "stream_output", seq, session_id: "session-1", payload: { phase: "intent_complete", content: "done", round: 1 } } as Envelope;
    rows.push({ session_seq: seq, session_id: "session-1", event_id: `event-${seq}`, run_id: null,
      payload: JSON.stringify({ client_event: event }) });
    return event;
  };
  return { handler, request, socket, sent, getRecoverySnapshot, read, add, publish: (event: Envelope) => listener(event), release, unsubscribe };
}

describe("session recovery snapshot handshake", () => {
  it("subscribes before capture, installs S, then delivers only events after S", async () => {
    const h = await harness();
    const capture = h.getRecoverySnapshot.getMockImplementation()!;
    h.getRecoverySnapshot.mockImplementation(async () => {
      const snapshot = await capture();
      h.publish(h.add(11));
      return snapshot;
    });
    const load = h.read.listOutboxForReplay.getMockImplementation()!;
    h.read.listOutboxForReplay.mockImplementationOnce(async input => {
      const rows = await load(input);
      h.add(12); // Durable commit without a live notification.
      h.publish(h.add(13)); // Notification arrives while the catch-up query is in flight.
      return rows;
    });
    await h.handler(h.socket, h.request);
    expect(h.socket.close).not.toHaveBeenCalled();
    expect(h.sent[0]?.type).toBe("session.snapshot");
    expect(h.sent.filter(event => event.seq !== undefined).map(event => event.seq)).toEqual([11, 12, 13]);
    expect(h.read.listOutboxForReplay.mock.calls.every(([input]) => Number(input.afterSeq) >= 10)).toBe(true);
    h.socket.emit("close");
    expect(h.release).toHaveBeenCalledOnce();
    expect(h.unsubscribe).toHaveBeenCalledOnce();
  });

  it("heartbeat catches up a durable event even when its live notification was lost", async () => {
    vi.useFakeTimers();
    const h = await harness();
    await h.handler(h.socket, h.request);
    h.add(11);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.sent.filter(event => event.seq !== undefined).map(event => event.seq)).toEqual([11]);
    expect(h.sent.at(-1)).toMatchObject({ type: "heartbeat", payload: { last_seq: 11 } });
    h.socket.emit("close");
  });

  it("reconnects for a new snapshot when the missing window has been collected", async () => {
    vi.useFakeTimers();
    const h = await harness();
    await h.handler(h.socket, h.request);
    h.add(11);
    h.read.listOutboxForReplay.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.socket.close).toHaveBeenCalledWith(1013, "snapshot recovery required");
    expect(h.release).toHaveBeenCalledOnce();
  });

  it.each([[12], [11, 13]])("does not skip a partially collected replay window: %j", async (...seqs: number[]) => {
    vi.useFakeTimers();
    const h = await harness();
    await h.handler(h.socket, h.request);
    for (const seq of seqs) h.add(seq);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(h.sent.filter(event => event.seq !== undefined).map(event => event.seq)).toEqual(seqs[0] === 11 ? [11] : []);
    expect(h.socket.close).toHaveBeenCalledWith(1013, "snapshot recovery required");
    expect(h.release).toHaveBeenCalledOnce();
  });
});
