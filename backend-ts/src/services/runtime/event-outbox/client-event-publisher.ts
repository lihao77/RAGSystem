import type { Envelope } from "../../../contracts/events.js";
import type {
  AppendOutboxInput,
  ConversationStoreTransaction,
  IOutboxStore,
  OutboxRow,
} from "../../../contracts/conversation-store/index.js";
import type { OutboxDispatcher } from "./dispatcher.js";

export interface ClientEventPublishOptions {
  runId?: string | null | undefined;
  aggregateType?: string | undefined;
  aggregateId?: string | undefined;
  eventType?: string | undefined;
}

export interface ClientEventPublisher {
  publish(sessionId: string, event: Envelope, options?: ClientEventPublishOptions): void;
}

export interface RecordedClientEvent {
  sessionId: string;
  event: Envelope;
  row: OutboxRow;
}

export class DurableClientEventPublisher {
  constructor(
    private readonly conversationStore: IOutboxStore,
    private readonly outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">,
  ) {}

  publish(sessionId: string, event: Envelope, options: ClientEventPublishOptions = {}): OutboxRow {
    const row = this.conversationStore.appendOutbox(this.toOutboxInput(sessionId, event, options));
    this.deliver([{ sessionId, event, row }]);
    return row;
  }

  recordInTransaction(
    tx: ConversationStoreTransaction,
    sessionId: string,
    event: Envelope,
    options: ClientEventPublishOptions = {},
  ): RecordedClientEvent {
    const row = tx.appendOutbox(this.toOutboxInput(sessionId, event, options));
    return { sessionId, event, row };
  }

  deliver(records: RecordedClientEvent[]): void {
    if (records.length === 0) {
      return;
    }
    this.outboxDispatcher.dispatchRows(records.map((record) => record.row));
  }

  private toOutboxInput(sessionId: string, event: Envelope, options: ClientEventPublishOptions): AppendOutboxInput {
    const runId = options.runId ?? event.run_id ?? null;
    return {
      sessionId,
      runId,
      eventType: options.eventType ?? `client.${event.type}`,
      aggregateType: options.aggregateType ?? (runId ? "run" : "session"),
      aggregateId: options.aggregateId ?? runId ?? sessionId,
      payload: {
        client_event: event,
      },
    };
  }
}
