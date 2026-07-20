import type { Envelope } from "../../../contracts/events.js";
import type { OutboxRow } from "../../../contracts/conversation-store/index.js";
import type {
  RuntimeRecordEnvelopeInput,
  RuntimeStorage,
} from "../../../contracts/storage/runtime-storage.js";
import {
  type ClientEventPublishOptions,
  withStableEventId,
} from "./client-event-publisher.js";
import type { AsyncOutboxDispatcher } from "./async-dispatcher.js";
import { buildExecutionEnvelopeRunStep } from "./execution-envelope-archive.js";

/** Durable client-event publisher for async SaaS repositories. */
export class AsyncDurableClientEventPublisher {
  private readonly sessionTails = new Map<string, Promise<void>>();
  private readonly sessionFailures = new Map<string, unknown>();

  constructor(
    private readonly storage: RuntimeStorage,
    private readonly dispatcher: Pick<AsyncOutboxDispatcher, "dispatchRows">,
  ) {}

  async publish(sessionId: string, event: Envelope, options: ClientEventPublishOptions = {}): Promise<OutboxRow> {
    const input = this.toRecordInput(sessionId, event, withStableEventId(options));
    // AgentExecutionEventPublisher is intentionally fire-and-forget. Serialize
    // per-session writes so concurrent envelopes cannot race session_seq allocation.
    const previous = this.sessionTails.get(sessionId) ?? Promise.resolve();
    const operation = previous.then(async () => {
      const { outbox: row } = await this.storage.operations.recordEnvelope(input);
      if (row.status === "pending") await this.dispatcher.dispatchRows([row]);
      return row;
    });
    const tail = operation.then(
      () => undefined,
      (error) => {
        if (!this.sessionFailures.has(sessionId)) this.sessionFailures.set(sessionId, error);
      },
    );
    this.sessionTails.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionTails.get(sessionId) === tail && !this.sessionFailures.has(sessionId)) {
        this.sessionTails.delete(sessionId);
      }
    });
    return operation;
  }

  async record(sessionId: string, event: Envelope, options: ClientEventPublishOptions = {}): Promise<OutboxRow> {
    const input = this.toRecordInput(sessionId, event, withStableEventId(options));
    return (await this.storage.operations.recordEnvelope(input)).outbox;
  }

  async flush(sessionId: string): Promise<void> {
    const tail = this.sessionTails.get(sessionId);
    await (tail ?? Promise.resolve());
    const failure = this.sessionFailures.get(sessionId);
    if (failure !== undefined) {
      this.sessionFailures.delete(sessionId);
      if (!tail || this.sessionTails.get(sessionId) === tail) this.sessionTails.delete(sessionId);
      throw failure;
    }
  }

  async deliver(rows: OutboxRow[]): Promise<void> {
    const pending = rows.filter((row) => row.status === "pending");
    if (pending.length > 0) await this.dispatcher.dispatchRows(pending);
  }

  private toRecordInput(
    sessionId: string,
    event: Envelope,
    options: ClientEventPublishOptions & { eventId: string },
  ): RuntimeRecordEnvelopeInput {
    const runId = options.runId ?? event.run_id ?? null;
    return {
      step: buildExecutionEnvelopeRunStep(sessionId, runId, event, options.eventId),
      outbox: {
        sessionId,
        runId,
        eventId: options.eventId,
        eventType: options.eventType ?? `client.${event.type}`,
        aggregateType: options.aggregateType ?? (runId ? "run" : "session"),
        aggregateId: options.aggregateId ?? runId ?? sessionId,
        payload: { client_event: event },
      },
    };
  }
}
