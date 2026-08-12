import { isDeepStrictEqual } from "node:util";
import { MessageContentPartSchema } from "@ragsystem/agent-protocol";
import type {
  AckAgentMailboxInput,
  AgentMailboxInputType,
  AgentMailboxMessage,
  AgentMailboxMessageKind,
  AgentMailboxMessageStatus,
  AgentMailboxSourceKind,
  AgentMailboxStorePort,
  ClaimAgentMailboxInput,
  EnqueueAgentMailboxMessageInput,
  ListPendingAgentMailboxInput,
  ReleaseAgentMailboxInput,
  SettleAgentMailboxInput,
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
  input_type: AgentMailboxInputType;
  source_kind: AgentMailboxSourceKind;
  visible_to_user: number;
  sent_at: string | null;
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
  kind, input_type, source_kind, visible_to_user, sent_at, correlation_id,
  reply_to_message_id, content_parts, metadata, status,
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
    input_type: row.input_type,
    source_kind: row.source_kind,
    visible_to_user: row.visible_to_user === 1,
    sent_at: iso(row.sent_at),
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
    && existing.input_type === (input.inputType ?? "agent_message")
    && existing.source_kind === (input.sourceKind ?? "agent")
    && (existing.visible_to_user === 1) === (input.visibleToUser ?? false)
    && iso(existing.sent_at) === (input.sentAt == null ? null : asNow(input.sentAt))
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

  enqueueInTransaction(input: EnqueueAgentMailboxMessageInput): AgentMailboxMessage {
    return this.enqueueSync(input, false);
  }

  async get(sessionId: string, messageId: string): Promise<AgentMailboxMessage | null> {
    return this.getSync(required(sessionId, "sessionId"), required(messageId, "messageId"));
  }

  async claim(input: ClaimAgentMailboxInput): Promise<AgentMailboxMessage[]> {
    return this.claimSync(input);
  }

  async listPending(input: ListPendingAgentMailboxInput): Promise<AgentMailboxMessage[]> {
    return this.listPendingSync(input);
  }

  async ack(input: AckAgentMailboxInput): Promise<boolean> {
    return this.ackSync(input);
  }

  async settle(input: SettleAgentMailboxInput): Promise<boolean> {
    return this.settleSync(input);
  }

  async release(input: ReleaseAgentMailboxInput): Promise<boolean> {
    return this.releaseSync(input);
  }

  async expire(input: { sessionId?: string; now?: string } = {}): Promise<number> {
    return this.expireSync(input);
  }

  private enqueueSync(input: EnqueueAgentMailboxMessageInput, startTransaction = true): AgentMailboxMessage {
    const messageId = required(input.messageId, "messageId");
    const tenantId = required(input.tenantId, "tenantId");
    const sessionId = required(input.sessionId, "sessionId");
    const targetThreadKey = required(input.targetThreadKey, "targetThreadKey");
    const availableAt = asNow(input.availableAt);
    const expiresAt = input.expiresAt == null ? null : asNow(input.expiresAt);
    const sentAt = input.sentAt == null ? null : asNow(input.sentAt);
    const insert = (): void => {
      const existing = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_mailbox WHERE tenant_id=? AND message_id=?`).get(tenantId, messageId) as AgentMailboxRow | undefined;
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
          kind, input_type, source_kind, visible_to_user, sent_at, correlation_id,
          reply_to_message_id, content_parts, metadata, available_at, expires_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        input.inputType ?? "agent_message",
        input.sourceKind ?? "agent",
        input.visibleToUser ? 1 : 0,
        sentAt,
        input.correlationId ?? null,
        input.replyToMessageId ?? null,
        stringifyJson(input.contentParts ?? []),
        stringifyJson(input.metadata ?? {}),
        availableAt,
        expiresAt,
      );
    };
    if (startTransaction) runInTransaction(this.db, insert);
    else insert();
    const created = this.getSync(sessionId, messageId);
    if (!created) throw new Error(`Agent mailbox insert failed: ${messageId}`);
    return created;
  }

  private getSync(sessionId: string, messageId: string): AgentMailboxMessage | null {
    const row = this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_mailbox WHERE session_id=? AND message_id=?`)
      .get(sessionId, messageId) as AgentMailboxRow | undefined;
    return row ? mapRow(row) : null;
  }

  private listPendingSync(input: ListPendingAgentMailboxInput): AgentMailboxMessage[] {
    const sessionId = required(input.sessionId, "sessionId");
    const now = asNow(input.now);
    this.db.prepare(`
      UPDATE agent_mailbox
      SET status='expired', claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL,
          last_error=COALESCE(last_error, 'message expired'), updated_at=?
      WHERE session_id=? AND status IN ('queued','claimed')
        AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(now, sessionId, now);
    this.db.prepare(`
      UPDATE agent_mailbox
      SET status='queued', claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL, updated_at=?
      WHERE session_id=? AND status='claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?
    `).run(now, sessionId, now);
    const clauses = ["session_id=?", "status='queued'", "available_at <= ?", "(expires_at IS NULL OR expires_at > ?)"];
    const params: Array<string | number> = [sessionId, now, now];
    const add = (column: string, value: string | null | undefined): void => {
      const normalized = value?.trim();
      if (!normalized) return;
      clauses.push(`${column}=?`);
      params.push(normalized);
    };
    add("target_run_id", input.targetRunId);
    add("target_agent_call_id", input.targetAgentCallId);
    add("target_thread_key", input.targetThreadKey);
    add("target_child_agent_id", input.targetChildAgentId);
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 100)));
    return this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM agent_mailbox WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(sent_at, created_at), seq ASC LIMIT ?`)
      .all(...params, limit)
      .map((row) => mapRow(row as unknown as AgentMailboxRow));
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
      const existingClaim = this.db.prepare(`
        SELECT ${SELECT_COLUMNS} FROM agent_mailbox
        WHERE session_id=? AND claim_id=? AND status='claimed'
        ORDER BY seq ASC
      `).all(sessionId, claimId) as unknown as AgentMailboxRow[];
      if (existingClaim.length > 0) return existingClaim.map(mapRow);
      const targetRunId = input.targetRunId?.trim() || null;
      const targetChildAgentId = input.targetChildAgentId?.trim() || null;
      const targetAgentCallId = input.targetAgentCallId?.trim() || null;
      const activeParams: string[] = [];
      let activeTarget = "target_run_id=? AND target_thread_key=?";
      activeParams.push(targetRunId ?? "", targetThreadKey);
      if (targetAgentCallId) {
        activeTarget += " AND target_agent_call_id=?";
        activeParams.push(targetAgentCallId);
      }
      if (targetChildAgentId) {
        activeTarget += " AND target_child_agent_id=?";
        activeParams.push(targetChildAgentId);
      }
      const idleParams: string[] = [targetThreadKey];
      let idleTarget = "target_run_id IS NULL AND target_thread_key=?";
      if (targetAgentCallId) {
        idleTarget += " AND (target_agent_call_id IS NULL OR target_agent_call_id=?)";
        idleParams.push(targetAgentCallId);
      }
      if (targetChildAgentId) {
        idleTarget += " AND target_child_agent_id=?";
        idleParams.push(targetChildAgentId);
      }
      const targetPredicate = targetRunId ? `(${activeTarget} OR ${idleTarget})` : idleTarget;
      const targetParams: string[] = targetRunId
        ? [...activeParams, ...idleParams]
        : idleParams;
      this.db.prepare(`
        UPDATE agent_mailbox
        SET status='claimed', claim_id=?, claimed_by=?, claim_expires_at=?,
            attempt_count=attempt_count+1, updated_at=?
        WHERE seq IN (
          SELECT seq FROM agent_mailbox
          WHERE session_id=? AND status='queued' AND available_at <= ?
            AND (expires_at IS NULL OR expires_at > ?)
            AND ${targetPredicate}
          ORDER BY COALESCE(sent_at, created_at), seq ASC LIMIT ?
        )
      `).run(
        claimId,
        consumerId,
        claimExpiresAt,
        now,
        sessionId,
        now,
        now,
        ...targetParams,
        limit,
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

  private settleSync(input: SettleAgentMailboxInput): boolean {
    const sessionId = required(input.sessionId, "sessionId");
    const messageId = required(input.messageId, "messageId");
    const now = nowIso();
    this.db.prepare(`
      UPDATE agent_mailbox
      SET status='acked', acked_at=COALESCE(acked_at, ?), updated_at=?,
          claim_id=NULL, claimed_by=NULL, claim_expires_at=NULL
      WHERE session_id=? AND message_id=? AND status IN ('queued','claimed')
    `).run(now, now, sessionId, messageId);
    const row = this.db.prepare(
      "SELECT status FROM agent_mailbox WHERE session_id=? AND message_id=?",
    ).get(sessionId, messageId) as { status: string } | undefined;
    return row?.status === "acked" || row?.status === "expired";
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
