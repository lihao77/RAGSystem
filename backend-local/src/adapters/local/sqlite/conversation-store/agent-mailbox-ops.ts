import { isDeepStrictEqual } from "node:util";
import { MessageContentPartSchema } from "@ragsystem/agent-protocol";
import type {
  AckAgentMailboxInput,
  AgentMailboxMessage,
  AgentMailboxMessageKind,
  AgentMailboxMessageStatus,
  AgentMailboxStorePort,
  ClaimAgentMailboxInput,
  EnqueueAgentMailboxMessageInput,
  ReleaseAgentMailboxInput,
} from "@ragsystem/backend-core/contracts/storage/agent-mailbox-repository.js";
import type { ConversationDb } from "./shared/db.js";
import { runInTransaction } from "./shared/transaction.js";
import { nowIso, normalizeNonEmptyString } from "./shared/primitives.js";
import { stringifyJson } from "./helpers.js";

interface AgentMailboxRow {
  seq: number;
  message_id: string;
  tenant_id: string;
  session_id: string;
  source_run_id: string | null;
  source_agent_call_id: string | null;
  target_run_id: string | null;
  target_agent_call_id: string | null;
  target_thread_key: string;
  target_child_agent_id: string | null;
  kind: AgentMailboxMessageKind;
  correlation_id: string | null;
  reply_to_message_id: string | null;
  content_parts: string;
  metadata: string;
  status: AgentMailboxMessageStatus;
  attempt_count: number;
  claim_id: string | null;
  claimed_by: string | null;
  claim_expires_at: string | null;
  available_at: string;
  expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  acked_at: string | null;
}

const SELECT_COLUMNS = `
  seq, message_id, tenant_id, session_id, source_run_id, source_agent_call_id,
  target_run_id, target_agent_call_id, target_thread_key, target_child_agent_id,
  kind, correlation_id, reply_to_message_id, content_parts, metadata, status,
  attempt_count, claim_id, claimed_by, claim_expires_at, available_at, expires_at,
  last_error, created_at, updated_at, acked_at
`;

function iso(value: string | null): string | null {
  if (value == null) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid mailbox timestamp: ${value}`);
  return parsed.toISOString();
}

function required(value: string, field: string): string {
  const normalized = normalizeNonEmptyString(value);
  if (!normalized) throw new Error(`Agent mailbox ${field} must not be empty`);
  return normalized;
}

function mapRow(row: AgentMailboxRow): AgentMailboxMessage {
  const parts = MessageContentPartSchema.array().safeParse(JSON.parse(row.content_parts || "[]"));
  if (!parts.success) throw new Error(`Invalid Agent mailbox content_parts: ${row.message_id}`);
  const metadata = JSON.parse(row.metadata || "{}");
  return {
    seq: Number(row.seq),
    message_id: row.message_id,
    tenant_id: row.tenant_id,
    session_id: row.session_id,
    source_run_id: row.source_run_id,
    source_agent_call_id: row.source_agent_call_id,
    target_run_id: row.target_run_id,
    target_agent_call_id: row.target_agent_call_id,
    target_thread_key: row.target_thread_key,
    target_child_agent_id: row.target_child_agent_id,
    kind: row.kind,
    correlation_id: row.correlation_id,
    reply_to_message_id: row.reply_to_message_id,
    content_parts: parts.data,
    metadata: metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {},
    status: row.status,
    attempt_count: Number(row.attempt_count),
    claim_id: row.claim_id,
    claimed_by: row.claimed_by,
    claim_expires_at: iso(row.claim_expires_at),
    available_at: iso(row.available_at) ?? row.available_at,
    expires_at: iso(row.expires_at),
    last_error: row.last_error,
    created_at: iso(row.created_at) ?? row.created_at,
    updated_at: iso(row.updated_at) ?? row.updated_at,
    acked_at: iso(row.acked_at),
  };
}

function asNow(value?: string): string {
  const candidate = value ?? nowIso();
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid mailbox now: ${candidate}`);
  return parsed.toISOString();
}

function sameMessageIdentity(
  existing: AgentMailboxRow,
  input: EnqueueAgentMailboxMessageInput,
  availableAt: string,
  expiresAt: string | null,
): boolean {
  const existingParts = MessageContentPartSchema.array().safeParse(JSON.parse(existing.content_parts || "[]"));
  const existingMetadata = JSON.parse(existing.metadata || "{}");
  return existingParts.success
    && existing.session_id === input.sessionId
    && existing.tenant_id === input.tenantId
    && existing.source_run_id === (input.sourceRunId ?? null)
    && existing.source_agent_call_id === (input.sourceAgentCallId ?? null)
    && existing.target_run_id === (input.targetRunId ?? null)
    && existing.target_agent_call_id === (input.targetAgentCallId ?? null)
    && existing.target_thread_key === input.targetThreadKey
    && existing.target_child_agent_id === (input.targetChildAgentId ?? null)
    && existing.kind === input.kind
    && existing.correlation_id === (input.correlationId ?? null)
    && existing.reply_to_message_id === (input.replyToMessageId ?? null)
    && isDeepStrictEqual(existingParts.data, input.contentParts ?? [])
    && isDeepStrictEqual(existingMetadata, input.metadata ?? {})
    && (input.availableAt === undefined || asNow(existing.available_at) === availableAt)
    && (input.expiresAt === undefined || (existing.expires_at == null ? null : asNow(existing.expires_at)) === expiresAt);
}

/** Synchronous SQLite implementation of the durable mailbox state machine. */
export class AgentMailboxOps implements AgentMailboxStorePort {
  constructor(private readonly db: ConversationDb) {}

  async enqueue(input: EnqueueAgentMailboxMessageInput): Promise<AgentMailboxMessage> {
    return this.enqueueSync(input);
  }

  async get(sessionId: string, messageId: string): Promise<AgentMailboxMessage | null> {
    return this.getSync(required(sessionId, "sessionId"), required(messageId, "messageId"));
  }

  async claim(input: ClaimAgentMailboxInput): Promise<AgentMailboxMessage[]> {
    return this.claimSync(input);
  }

  async ack(input: AckAgentMailboxInput): Promise<boolean> {
    return this.ackSync(input);
  }

  async release(input: ReleaseAgentMailboxInput): Promise<boolean> {
    return this.releaseSync(input);
  }

  async expire(input: { sessionId?: string; now?: string } = {}): Promise<number> {
    return this.expireSync(input);
  }

  private enqueueSync(input: EnqueueAgentMailboxMessageInput): AgentMailboxMessage {
    const messageId = required(input.messageId, "messageId");
    const tenantId = required(input.tenantId, "tenantId");
    const sessionId = required(input.sessionId, "sessionId");
    const targetThreadKey = required(input.targetThreadKey, "targetThreadKey");
    const availableAt = asNow(input.availableAt);
    const expiresAt = input.expiresAt == null ? null : asNow(input.expiresAt);
    runInTransaction(this.db, () => {
      const existing = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_mailbox WHERE message_id=?`).get(messageId) as AgentMailboxRow | undefined;
      if (existing) {
        if (!sameMessageIdentity(existing, input, availableAt, expiresAt)) {
          throw new Error(`Agent mailbox message id already belongs to another message: ${messageId}`);
        }
        return;
      }
      this.db.prepare(`
        INSERT INTO agent_mailbox (
          message_id, tenant_id, session_id, source_run_id, source_agent_call_id,
          target_run_id, target_agent_call_id, target_thread_key, target_child_agent_id,
          kind, correlation_id, reply_to_message_id, content_parts, metadata,
          available_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageId,
        tenantId,
        sessionId,
        input.sourceRunId ?? null,
        input.sourceAgentCallId ?? null,
        input.targetRunId ?? null,
        input.targetAgentCallId ?? null,
        targetThreadKey,
        input.targetChildAgentId ?? null,
        input.kind,
        input.correlationId ?? null,
        input.replyToMessageId ?? null,
        stringifyJson(input.contentParts ?? []),
        stringifyJson(input.metadata ?? {}),
        availableAt,
        expiresAt,
      );
    });
    const created = this.getSync(sessionId, messageId);
    if (!created) throw new Error(`Agent mailbox insert failed: ${messageId}`);
    return created;
  }

  private getSync(sessionId: string, messageId: string): AgentMailboxMessage | null {
    const row = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_mailbox WHERE session_id=? AND message_id=?`)
      .get(sessionId, messageId) as AgentMailboxRow | undefined;
    return row ? mapRow(row) : null;
  }

  private claimSync(input: ClaimAgentMailboxInput): AgentMailboxMessage[] {
    const sessionId = required(input.sessionId, "sessionId");
    const targetThreadKey = required(input.targetThreadKey, "targetThreadKey");
    const claimId = required(input.claimId, "claimId");
    const consumerId = required(input.consumerId, "consumerId");
    const now = asNow(input.now);
    const leaseMs = Math.max(1, Math.floor(input.leaseMs ?? 30_000));
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const claimExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    return runInTransaction(this.db, () => {
      this.db.prepare(`
        UPDATE agent_mailbox
        SET status='expired', claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL,
            last_error=COALESCE(last_error, 'message expired'), updated_at=?
        WHERE session_id=? AND status IN ('queued','claimed')
          AND expires_at IS NOT NULL AND expires_at <= ?
      `).run(now, sessionId, now);
      this.db.prepare(`
        UPDATE agent_mailbox
        SET status='queued', claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL,
            updated_at=?
        WHERE session_id=? AND status='claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
      `).run(now, sessionId, now);
      const targetRunId = input.targetRunId?.trim() || null;
      const targetChildAgentId = input.targetChildAgentId?.trim() || null;
      const targetAgentCallId = input.targetAgentCallId?.trim() || null;
      const activeTarget = targetRunId
        ? `target_run_id=?${targetAgentCallId ? " AND target_agent_call_id=?" : ""}`
        : "target_run_id IS NULL";
      const idleTarget = `target_run_id IS NULL AND target_thread_key=?${targetAgentCallId ? " AND (target_agent_call_id IS NULL OR target_agent_call_id=?)" : ""}${targetChildAgentId ? " AND target_child_agent_id=?" : ""}`;
      const targetPredicate = targetRunId
        ? `(${activeTarget} OR ${idleTarget})`
        : idleTarget;
      const targetParams: string[] = targetRunId
        ? [targetRunId, ...(targetAgentCallId ? [targetAgentCallId] : []), targetThreadKey, ...(targetAgentCallId ? [targetAgentCallId] : [])]
        : [targetThreadKey];
      if (!targetRunId && targetAgentCallId) targetParams.push(targetAgentCallId);
      if (targetChildAgentId) targetParams.push(targetChildAgentId);
      const rows = this.db.prepare(`
        SELECT seq, message_id FROM agent_mailbox
        WHERE session_id=? AND status='queued' AND available_at <= ?
          AND (expires_at IS NULL OR expires_at > ?)
          AND ${targetPredicate}
        ORDER BY seq ASC LIMIT ?
      `).all(sessionId, now, now, ...targetParams, limit) as Array<{ seq: number; message_id: string }>;
      if (rows.length === 0) return [];
      const placeholders = rows.map(() => "?").join(",");
      this.db.prepare(`
        UPDATE agent_mailbox
        SET status='claimed', claim_id=?, claimed_by=?, claim_expires_at=?,
            attempt_count=attempt_count+1, updated_at=?
        WHERE session_id=? AND status='queued' AND seq IN (${placeholders})
      `).run(
        claimId,
        consumerId,
        claimExpiresAt,
        now,
        sessionId,
        ...rows.map((row) => row.seq),
      );
      return this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_mailbox WHERE session_id=? AND claim_id=? ORDER BY seq ASC`)
        .all(sessionId, claimId).map((row) => mapRow(row as unknown as AgentMailboxRow));
    });
  }

  private ackSync(input: AckAgentMailboxInput): boolean {
    const now = nowIso();
    const result = this.db.prepare(`
      UPDATE agent_mailbox
      SET status='acked', acked_at=?, updated_at=?, claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL
      WHERE session_id=? AND message_id=? AND status='claimed' AND claim_id=?
    `).run(now, now, required(input.sessionId, "sessionId"), required(input.messageId, "messageId"), required(input.claimId, "claimId"));
    return Number(result.changes ?? 0) > 0;
  }

  private releaseSync(input: ReleaseAgentMailboxInput): boolean {
    const now = nowIso();
    const availableAt = input.availableAt == null ? now : asNow(input.availableAt);
    const result = this.db.prepare(`
      UPDATE agent_mailbox
      SET status='queued', claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL,
          available_at=?, last_error=?, updated_at=?
      WHERE session_id=? AND message_id=? AND status='claimed' AND claim_id=?
    `).run(availableAt, input.lastError ?? null, now, required(input.sessionId, "sessionId"), required(input.messageId, "messageId"), required(input.claimId, "claimId"));
    return Number(result.changes ?? 0) > 0;
  }

  private expireSync(input: { sessionId?: string; now?: string }): number {
    const now = asNow(input.now);
    const sessionId = input.sessionId?.trim() || null;
    const result = sessionId
      ? this.db.prepare(`UPDATE agent_mailbox SET status='expired', claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL, updated_at=? WHERE session_id=? AND status IN ('queued','claimed') AND expires_at IS NOT NULL AND expires_at <= ?`).run(now, sessionId, now)
      : this.db.prepare(`UPDATE agent_mailbox SET status='expired', claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL, updated_at=? WHERE status IN ('queued','claimed') AND expires_at IS NOT NULL AND expires_at <= ?`).run(now, now);
    return Number(result.changes ?? 0);
  }
}
