import { randomUUID } from "node:crypto";

import type { Envelope } from "../../../contracts/events.js";
import type {
  AppendOutboxInput,
  ConversationStoreTransaction,
  IConversationTransactionRunner,
  IOutboxStore,
  OutboxRow,
} from "../../../contracts/conversation-store/index.js";
import type { OutboxDispatcher } from "./dispatcher.js";
import { archiveExecutionEnvelope } from "./execution-envelope-archive.js";

export interface ClientEventPublishOptions {
  runId?: string | null | undefined;
  aggregateType?: string | undefined;
  aggregateId?: string | undefined;
  eventType?: string | undefined;
  eventId?: string | undefined;
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
    private readonly conversationStore: IOutboxStore & IConversationTransactionRunner,
    private readonly outboxDispatcher: Pick<OutboxDispatcher, "dispatchRows">,
  ) {}

  publish(sessionId: string, event: Envelope, options: ClientEventPublishOptions = {}): OutboxRow {
    const resolvedOptions = withStableEventId(options);
    const record = this.conversationStore.runInTransaction((tx) =>
      this.recordInTransaction(tx, sessionId, event, resolvedOptions),
    );
    this.deliver([record]);
    return record.row;
  }

  recordInTransaction(
    tx: ConversationStoreTransaction,
    sessionId: string,
    event: Envelope,
    options: ClientEventPublishOptions = {},
  ): RecordedClientEvent {
    const resolvedOptions = withStableEventId(options);
    const runId = options.runId ?? event.run_id ?? null;
    archiveExecutionEnvelope(tx, sessionId, runId, event, resolvedOptions.eventId);
    const row = tx.appendOutbox(this.toOutboxInput(sessionId, event, resolvedOptions));
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
      eventId: options.eventId,
      eventType: options.eventType ?? `client.${event.type}`,
      aggregateType: options.aggregateType ?? (runId ? "run" : "session"),
      aggregateId: options.aggregateId ?? runId ?? sessionId,
      payload: {
        client_event: event,
      },
    };
  }
}

type ResolvedClientEventPublishOptions = ClientEventPublishOptions & { eventId: string };

export function withStableEventId(
  options: ClientEventPublishOptions,
): ResolvedClientEventPublishOptions {
  const supplied = options.eventId?.trim();
  if (options.eventId !== undefined && !supplied) {
    throw new Error("client eventId must not be empty");
  }
  return { ...options, eventId: supplied ?? randomUUID() };
}
