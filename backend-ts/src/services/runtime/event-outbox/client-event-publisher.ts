import type { ClientEvent } from "../../../contracts/events.js";
import type {
  AppendOutboxInput,
  ConversationStore,
  ConversationStoreTransaction,
} from "../../stores/conversation-store.js";
import type { OutboxRow } from "../../stores/conversation-store/types.js";
import type { OutboxDispatcher } from "./dispatcher.js";

export interface ClientEventPublishOptions {
  runId?: string | null | undefined;
  aggregateType?: string | undefined;
  aggregateId?: string | undefined;
  eventType?: string | undefined;
}

export interface ClientEventPublisher {
  publish(sessionId: string, event: ClientEvent, options?: ClientEventPublishOptions): void;
}

export interface RecordedClientEvent {
  sessionId: string;
  event: ClientEvent;
  row: OutboxRow;
}

export class DurableClientEventPublisher {
  constructor(
    private readonly conversationStore: ConversationStore,
    private readonly outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">,
  ) {}

  publish(sessionId: string, event: ClientEvent, options: ClientEventPublishOptions = {}): OutboxRow {
    const row = this.conversationStore.appendOutbox(this.toOutboxInput(sessionId, event, options));
    this.deliver([{ sessionId, event, row }]);
    return row;
  }

  recordInTransaction(
    tx: ConversationStoreTransaction,
    sessionId: string,
    event: ClientEvent,
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

  private toOutboxInput(sessionId: string, event: ClientEvent, options: ClientEventPublishOptions): AppendOutboxInput {
    const runId = options.runId ?? event.run_id ?? null;
    return {
      sessionId,
      runId,
      eventType: options.eventType ?? `client.${event.type}`,
      aggregateType: options.aggregateType ?? (runId ? "run" : "session"),
      aggregateId: options.aggregateId ?? runId ?? sessionId,
      payload: {
        client_event: sanitizeClientEvent(event),
      },
    };
  }
}

function sanitizeClientEvent(event: ClientEvent): ClientEvent {
  const {
    stream_seq: _streamSeq,
    event_id: _eventId,
    event_seq: _eventSeq,
    ...rest
  } = event;
  return { ...rest };
}
