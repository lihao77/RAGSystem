import type { ConversationDb } from './shared/db.js';
import { hydrateMessageRequestStatus, type QueuedMessageRequestCancellation } from '@ragsystem/backend-core/contracts/session/message-request-status.js';
import { runInTransaction } from './shared/transaction.js';

/** Shape-driven initialization also runs when an existing database is already at its schema version. */
export function hydrateMessageRequestSchema(db: ConversationDb): void {
  db.exec(`CREATE TABLE IF NOT EXISTS session_message_requests (
    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
    request_id TEXT NOT NULL,
    content TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'unknown',
    error TEXT,
    updated_at TEXT NOT NULL DEFAULT '',
    PRIMARY KEY(session_id, request_id)
  )`);
  const columns = new Set((db.prepare('PRAGMA table_info(session_message_requests)').all() as { name: string }[]).map(row => row.name));
  for (const [name, definition] of Object.entries({ content: "TEXT NOT NULL DEFAULT ''", status: "TEXT NOT NULL DEFAULT 'unknown'", error: 'TEXT', updated_at: "TEXT NOT NULL DEFAULT ''" })) {
    if (!columns.has(name)) db.exec(`ALTER TABLE session_message_requests ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS messages_root_request_idx ON messages(session_id, json_extract(metadata, '$.request_id')) WHERE role='user' AND thread_key='root'`);
  for (const [suffix, event] of [['insert', 'INSERT'], ['update', 'UPDATE OF metadata, role, thread_key']]) {
    db.exec(`CREATE TRIGGER IF NOT EXISTS messages_consume_request_${suffix} AFTER ${event} ON messages
      WHEN NEW.role='user' AND NEW.thread_key='root' AND json_type(NEW.metadata, '$.request_id')='text'
      BEGIN
        UPDATE session_message_requests SET status='consumed', error=NULL, updated_at=strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE session_id=NEW.session_id AND request_id=json_extract(NEW.metadata, '$.request_id');
      END`);
  }
  // A restored partial cancellation must stop delivery before the consumer starts.
  db.exec(`UPDATE agent_mailbox AS b SET status='expired', last_error='user_cancelled'
    WHERE b.status='queued' AND b.target_thread_key='root' AND b.input_type='user_message'
      AND EXISTS (SELECT 1 FROM session_message_requests r WHERE r.session_id=b.session_id
        AND r.request_id=json_extract(b.metadata, '$.request_id') AND r.status='cancelled')`);
}

export class MessageRequestOps {
  constructor(private readonly db: ConversationDb) {}

  cancelQueuedMessageRequest(input: QueuedMessageRequestCancellation): boolean {
    const now = new Date().toISOString();
    return runInTransaction(this.db, () => {
      // Write first: acquire SQLite's writer lock before inspecting the consumer-owned row.
      const result = this.db.prepare(`UPDATE agent_mailbox SET status='expired', last_error='user_cancelled', updated_at=? WHERE seq=(
        SELECT b.seq FROM agent_mailbox b JOIN session_message_requests r
          ON r.session_id=b.session_id AND r.request_id=json_extract(b.metadata, '$.request_id')
        WHERE b.session_id=? AND r.request_id=? AND r.content=? AND r.status IN ('processing', 'queued')
          AND b.target_thread_key='root' AND b.input_type='user_message' AND b.visible_to_user=1
          AND b.status='queued' AND (b.expires_at IS NULL OR b.expires_at>?)
          AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id=r.session_id AND m.role='user'
            AND m.thread_key='root' AND json_extract(m.metadata, '$.request_id')=r.request_id)
        ORDER BY b.seq LIMIT 1)`)
        .run(now, input.sessionId, input.requestId, input.expectedContent, now);
      if (!result.changes) return false;
      this.db.prepare(`UPDATE session_message_requests SET content=?, status='cancelled', error=NULL, updated_at=?
        WHERE session_id=? AND request_id=?`).run(input.expectedContent, now, input.sessionId, input.requestId);
      return true;
    });
  }

  beginMessageRequest(sessionId: string, requestId: string, content: string): boolean {
    return this.db.prepare(`INSERT INTO session_message_requests(session_id, request_id, content, status, updated_at)
      VALUES(?, ?, ?, 'processing', ?) ON CONFLICT(session_id, request_id) DO NOTHING`)
      .run(sessionId, requestId, content, new Date().toISOString()).changes > 0;
  }

  settleMessageRequest(sessionId: string, requestId: string, status: 'queued' | 'consumed' | 'failed', error?: string | null): void {
    this.db.prepare(`UPDATE session_message_requests SET status=?, error=?, updated_at=?
      WHERE session_id=? AND request_id=? AND status='processing'`)
      .run(status, error ?? null, new Date().toISOString(), sessionId, requestId);
  }

  renewMessageRequest(sessionId: string, requestId: string): void {
    this.db.prepare("UPDATE session_message_requests SET updated_at=? WHERE session_id=? AND request_id=? AND status='processing'")
      .run(new Date().toISOString(), sessionId, requestId);
  }

  listMessageRequestStatuses(sessionId: string, requestIds: readonly string[] = []) {
    this.db.prepare(`UPDATE session_message_requests AS r SET status='failed', error='发送处理已中断，请重新发送', updated_at=?
      WHERE session_id=? AND status='processing' AND updated_at<?
        AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.session_id=r.session_id AND m.role='user' AND m.thread_key='root' AND json_extract(m.metadata, '$.request_id')=r.request_id)
        AND NOT EXISTS (SELECT 1 FROM agent_mailbox b WHERE b.session_id=r.session_id AND b.target_thread_key='root'
          AND b.input_type='user_message' AND json_extract(b.metadata, '$.request_id')=r.request_id)`)
      .run(new Date().toISOString(), sessionId, new Date(Date.now() - 120_000).toISOString());
    // Upgrade/recovery: old queued mailbox inputs predate durable send receipts.
    this.db.prepare(`INSERT INTO session_message_requests(session_id, request_id, content, status, updated_at)
      SELECT session_id, json_extract(metadata, '$.request_id'),
        COALESCE((SELECT group_concat(json_extract(value, '$.text'), char(10)) FROM json_each(content_parts) WHERE json_extract(value, '$.type')='text'), ''),
        CASE WHEN EXISTS (SELECT 1 FROM messages m WHERE m.session_id=agent_mailbox.session_id AND m.role='user'
          AND m.thread_key='root' AND json_extract(m.metadata, '$.request_id')=json_extract(agent_mailbox.metadata, '$.request_id'))
          THEN 'consumed' ELSE 'queued' END, updated_at FROM agent_mailbox
      WHERE session_id=? AND target_thread_key='root' AND input_type='user_message' AND visible_to_user=1
        AND (status IN ('queued', 'claimed') OR (status='expired' AND last_error='user_cancelled'
          AND EXISTS (SELECT 1 FROM session_message_requests r WHERE r.session_id=agent_mailbox.session_id
            AND r.request_id=json_extract(agent_mailbox.metadata, '$.request_id') AND r.status='cancelled')))
        AND json_type(metadata, '$.request_id')='text'
        AND json_extract(metadata, '$.request_id')!=''
      ON CONFLICT(session_id, request_id) DO UPDATE SET
        status=CASE WHEN session_message_requests.status IN ('processing', 'queued', 'consumed', 'failed', 'cancelled')
          THEN session_message_requests.status ELSE excluded.status END,
        content=COALESCE(NULLIF(session_message_requests.content, ''), excluded.content),
        updated_at=COALESCE(NULLIF(session_message_requests.updated_at, ''), excluded.updated_at)
      WHERE session_message_requests.status NOT IN ('processing', 'queued', 'consumed', 'failed', 'cancelled') OR session_message_requests.status IS NULL
        OR session_message_requests.content IS NULL OR session_message_requests.content=''
        OR session_message_requests.updated_at IS NULL OR session_message_requests.updated_at=''`).run(sessionId);
    // Older receipts can predate the consumption trigger, and rollback can remove the user row.
    // The mailbox acknowledgement is durable evidence that this input already entered context.
    this.db.prepare(`UPDATE session_message_requests AS r SET status='consumed', error=NULL, updated_at=?
      WHERE session_id=? AND status IS NOT 'consumed' AND (
        EXISTS (SELECT 1 FROM messages m WHERE m.session_id=r.session_id AND m.role='user' AND m.thread_key='root'
          AND json_extract(m.metadata, '$.request_id')=r.request_id)
        OR EXISTS (SELECT 1 FROM agent_mailbox b WHERE b.session_id=r.session_id AND b.target_thread_key='root'
          AND b.input_type='user_message' AND b.status='acked' AND json_extract(b.metadata, '$.request_id')=r.request_id))`)
      .run(new Date().toISOString(), sessionId);
    return this.readMessageRequestStatuses(sessionId, requestIds);
  }

  readMessageRequestStatuses(sessionId: string, requestIds: readonly string[] = []) {
    const rows = this.db.prepare(`SELECT r.request_id, r.content,
      CASE WHEN m.id IS NOT NULL OR r.status='consumed' OR b.status='acked' THEN 'consumed' WHEN r.status='cancelled' THEN 'cancelled' WHEN r.status='failed' OR b.status='expired' THEN 'failed'
        WHEN b.status IN ('queued', 'claimed') THEN 'queued' ELSE r.status END AS status,
      m.id AS message_id, CASE WHEN r.status='cancelled' THEN NULL WHEN b.status='expired' THEN COALESCE(b.last_error, '排队消息已过期') ELSE r.error END AS error, r.updated_at,
      CASE WHEN r.status IN ('processing', 'queued') AND m.id IS NULL AND b.status='queued' AND b.visible_to_user=1
        AND (b.expires_at IS NULL OR b.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) THEN 1 ELSE 0 END AS can_manage
      FROM session_message_requests r
      LEFT JOIN messages m ON m.id=(SELECT id FROM messages WHERE session_id=r.session_id
        AND role='user' AND thread_key='root' AND json_extract(metadata, '$.request_id')=r.request_id ORDER BY seq LIMIT 1)
      LEFT JOIN agent_mailbox b ON b.seq=(SELECT seq FROM agent_mailbox WHERE session_id=r.session_id
        AND target_thread_key='root' AND input_type='user_message' AND json_extract(metadata, '$.request_id')=r.request_id ORDER BY seq LIMIT 1)
      WHERE r.session_id=? AND ((r.status IN ('processing', 'queued') AND m.id IS NULL AND (b.status IS NULL OR b.status NOT IN ('acked', 'expired')))
        OR r.request_id IN (SELECT value FROM json_each(?)))
      ORDER BY COALESCE(b.sent_at, b.created_at, r.updated_at), r.request_id`).all(sessionId, JSON.stringify(requestIds)) as Record<string, unknown>[];
    return rows.map(hydrateMessageRequestStatus);
  }
}
