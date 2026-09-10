export type MessageRequestState = 'processing' | 'queued' | 'consumed' | 'failed' | 'unknown';

export interface MessageRequestStatus {
  request_id: string;
  status: MessageRequestState;
  content: string;
  message_id: string | null;
  error: string | null;
  updated_at: string;
}

/** Durable receipt for a send, independent of the WebSocket that submitted it. */
export interface MessageRequestStatusPort {
  beginMessageRequest(sessionId: string, requestId: string, content: string): Promise<boolean>;
  renewMessageRequest(sessionId: string, requestId: string): Promise<void>;
  settleMessageRequest(sessionId: string, requestId: string, status: 'queued' | 'consumed' | 'failed', error?: string | null): Promise<void>;
  listMessageRequestStatuses(sessionId: string, requestIds?: readonly string[]): Promise<MessageRequestStatus[]>;
}

/** Permanent read normalization: a partial/invalid receipt never implies successful delivery. */
export function hydrateMessageRequestStatus(row: Record<string, unknown>): MessageRequestStatus {
  const status = row.status;
  return {
    request_id: String(row.request_id),
    status: status === 'processing' || status === 'queued' || status === 'consumed' || status === 'failed' ? status : 'unknown',
    content: typeof row.content === 'string' ? row.content : '',
    message_id: typeof row.message_id === 'string' ? row.message_id : null,
    error: typeof row.error === 'string' ? row.error : null,
    updated_at: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at ?? ''),
  };
}
