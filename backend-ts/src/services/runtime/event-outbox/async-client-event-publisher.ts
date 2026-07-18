import type { Envelope } from "../../../contracts/events.js";
import type { AppendOutboxInput, AsyncOutboxStore, OutboxRow } from "../../../contracts/conversation-store/index.js";
import type { ClientEventPublishOptions } from "./client-event-publisher.js";
import type { AsyncOutboxDispatcher } from "./async-dispatcher.js";

/** Durable client-event publisher for async SaaS repositories. */
export class AsyncDurableClientEventPublisher {
  constructor(
    private readonly outbox: Pick<AsyncOutboxStore, "appendOutbox">,
    private readonly dispatcher: Pick<AsyncOutboxDispatcher, "dispatchRows">,
  ) {}

  async publish(sessionId: string, event: Envelope, options: ClientEventPublishOptions = {}): Promise<OutboxRow> {
    const row = await this.outbox.appendOutbox(this.toOutboxInput(sessionId, event, options));
    await this.dispatcher.dispatchRows([row]);
    return row;
  }

  async record(sessionId: string, event: Envelope, options: ClientEventPublishOptions = {}): Promise<OutboxRow> {
    return this.outbox.appendOutbox(this.toOutboxInput(sessionId, event, options));
  }

  async deliver(rows: OutboxRow[]): Promise<void> {
    if (rows.length > 0) await this.dispatcher.dispatchRows(rows);
  }

  private toOutboxInput(sessionId: string, event: Envelope, options: ClientEventPublishOptions): AppendOutboxInput {
    const runId = options.runId ?? event.run_id ?? null;
    return {
      sessionId,
      runId,
      eventType: options.eventType ?? `client.${event.type}`,
      aggregateType: options.aggregateType ?? (runId ? "run" : "session"),
      aggregateId: options.aggregateId ?? runId ?? sessionId,
      payload: { client_event: event },
    };
  }
}
