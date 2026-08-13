import type {
  AckAgentMailboxInput,
  AgentMailboxMessage,
  AgentMailboxStorePort,
  ClaimAgentMailboxInput,
  EnqueueAgentMailboxMessageInput,
  ListPendingAgentMailboxInput,
  ReleaseAgentMailboxInput,
  SettleAgentMailboxInput,
} from "@ragsystem/backend-core/contracts/storage/agent-mailbox-repository.js";
import { MessageContentPartSchema } from "@ragsystem/agent-protocol";
import type { TenantId } from "@ragsystem/backend-core/identity/types.js";
import type { PostgresExecutor } from "./postgres-executor.js";
import { isDeepStrictEqual } from "node:util";

const SELECT_COLUMNS = `
  seq,message_id,tenant_id,session_id,source_run_id,source_agent_call_id,
  target_run_id,target_agent_call_id,target_thread_key,target_child_agent_id,
  kind,input_type,source_kind,visible_to_user,sent_at,correlation_id,
  reply_to_message_id,content_parts,metadata,status,
  attempt_count,claim_id,claimed_by,claim_expires_at,available_at,expires_at,
  last_error,created_at,updated_at,acked_at
`;

const toIso = (value: unknown): string | null => {
  if (value == null) return null;
  const parsed = new Date(String(value));
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid Agent mailbox timestamp: ${String(value)}`);
  return parsed.toISOString();
};

const required = (value: string, field: string): string => {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Agent mailbox ${field} must not be empty`);
  return normalized;
};

function row(value: Record<string, unknown>): AgentMailboxMessage {
  const parts = MessageContentPartSchema.array().safeParse(value.content_parts ?? []);
  if (!parts.success) throw new Error(`Invalid Agent mailbox content_parts: ${String(value.message_id)}`);
  const metadata = value.metadata && typeof value.metadata === "object" && !Array.isArray(value.metadata)
    ? value.metadata as Record<string, unknown>
    : {};
  return {
    seq: Number(value.seq),
    message_id: String(value.message_id),
    tenant_id: String(value.tenant_id),
    session_id: String(value.session_id),
    source_run_id: value.source_run_id == null ? null : String(value.source_run_id),
    source_agent_call_id: value.source_agent_call_id == null ? null : String(value.source_agent_call_id),
    target_run_id: value.target_run_id == null ? null : String(value.target_run_id),
    target_agent_call_id: value.target_agent_call_id == null ? null : String(value.target_agent_call_id),
    target_thread_key: String(value.target_thread_key),
    target_child_agent_id: value.target_child_agent_id == null ? null : String(value.target_child_agent_id),
    kind: value.kind as AgentMailboxMessage["kind"],
    input_type: value.input_type as AgentMailboxMessage["input_type"],
    source_kind: value.source_kind as AgentMailboxMessage["source_kind"],
    visible_to_user: value.visible_to_user === true,
    sent_at: toIso(value.sent_at),
    correlation_id: value.correlation_id == null ? null : String(value.correlation_id),
    reply_to_message_id: value.reply_to_message_id == null ? null : String(value.reply_to_message_id),
    content_parts: parts.data,
    metadata,
    status: value.status as AgentMailboxMessage["status"],
    attempt_count: Number(value.attempt_count),
    claim_id: value.claim_id == null ? null : String(value.claim_id),
    claimed_by: value.claimed_by == null ? null : String(value.claimed_by),
    claim_expires_at: toIso(value.claim_expires_at),
    available_at: toIso(value.available_at) ?? String(value.available_at),
    expires_at: toIso(value.expires_at),
    last_error: value.last_error == null ? null : String(value.last_error),
    created_at: toIso(value.created_at) ?? String(value.created_at),
    updated_at: toIso(value.updated_at) ?? String(value.updated_at),
    acked_at: toIso(value.acked_at),
  };
}

function timestamp(value: string | undefined): string {
  const candidate = value ?? new Date().toISOString();
  const parsed = new Date(candidate);
  if (!Number.isFinite(parsed.getTime())) throw new Error(`Invalid Agent mailbox timestamp: ${candidate}`);
  return parsed.toISOString();
}

function sameMessageIdentity(
  existing: AgentMailboxMessage,
  input: EnqueueAgentMailboxMessageInput,
  availableAt: string,
  expiresAt: string | null,
): boolean {
  return existing.tenant_id === input.tenantId
    && existing.session_id === input.sessionId
    && existing.source_run_id === (input.sourceRunId ?? null)
    && existing.source_agent_call_id === (input.sourceAgentCallId ?? null)
    && existing.target_run_id === (input.targetRunId ?? null)
    && existing.target_agent_call_id === (input.targetAgentCallId ?? null)
    && existing.target_thread_key === input.targetThreadKey
    && existing.target_child_agent_id === (input.targetChildAgentId ?? null)
    && existing.kind === input.kind
    && existing.input_type === (input.inputType ?? "agent_message")
    && existing.source_kind === (input.sourceKind ?? "agent")
    && existing.visible_to_user === (input.visibleToUser ?? false)
    && existing.sent_at === (input.sentAt == null ? null : timestamp(input.sentAt))
    && existing.correlation_id === (input.correlationId ?? null)
    && existing.reply_to_message_id === (input.replyToMessageId ?? null)
    && isDeepStrictEqual(existing.content_parts, input.contentParts ?? [])
    && isDeepStrictEqual(existing.metadata, input.metadata ?? {})
    && (input.availableAt === undefined || existing.available_at === availableAt)
    && (input.expiresAt === undefined || existing.expires_at === expiresAt);
}

/** Tenant-bound PostgreSQL mailbox. Every query includes tenant_id by construction. */
export class PostgresAgentMailboxRepository implements AgentMailboxStorePort {
  constructor(private readonly tenantId: TenantId | string, private readonly executor: PostgresExecutor) {}

  private tenant(): string { return required(String(this.tenantId), "tenantId"); }

  async enqueue(input: EnqueueAgentMailboxMessageInput): Promise<AgentMailboxMessage> {
    const tenantId = this.tenant();
    if (input.tenantId !== tenantId) throw new Error("Agent mailbox tenant mismatch");
    const messageId = required(input.messageId, "messageId");
    const sessionId = required(input.sessionId, "sessionId");
    const targetThreadKey = required(input.targetThreadKey, "targetThreadKey");
    const availableAt = timestamp(input.availableAt);
    const expiresAt = input.expiresAt == null ? null : timestamp(input.expiresAt);
    const sentAt = input.sentAt == null ? null : timestamp(input.sentAt);
    // message_id is unique per tenant, not per session. Resolve the existing
    // row without a session filter so a cross-session reuse is reported as an
    // identity conflict instead of a misleading insert failure.
    const existing = await this.getByTenantMessageId(messageId);
    if (existing) {
      if (!sameMessageIdentity(existing, input, availableAt, expiresAt)) throw new Error(`Agent mailbox message id conflict: ${messageId}`);
      return existing;
    }
    await this.executor.query(`
      INSERT INTO agent_mailbox_messages (
        message_id,tenant_id,session_id,source_run_id,source_agent_call_id,
        target_run_id,target_agent_call_id,target_thread_key,target_child_agent_id,
        kind,input_type,source_kind,visible_to_user,sent_at,correlation_id,
        reply_to_message_id,content_parts,metadata,available_at,expires_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::timestamptz,$15,$16,$17::jsonb,$18::jsonb,$19::timestamptz,$20::timestamptz)
      ON CONFLICT (tenant_id,message_id) DO NOTHING
    `, [
      messageId, tenantId, sessionId, input.sourceRunId ?? null, input.sourceAgentCallId ?? null,
      input.targetRunId ?? null, input.targetAgentCallId ?? null, targetThreadKey, input.targetChildAgentId ?? null,
      input.kind, input.inputType ?? "agent_message", input.sourceKind ?? "agent", input.visibleToUser ?? false,
      sentAt, input.correlationId ?? null, input.replyToMessageId ?? null,
      JSON.stringify(input.contentParts ?? []), JSON.stringify(input.metadata ?? {}), availableAt,
      expiresAt,
    ]);
    const created = await this.getByTenantMessageId(messageId);
    if (!created) throw new Error(`Agent mailbox insert failed: ${messageId}`);
    if (!sameMessageIdentity(created, input, availableAt, expiresAt)) throw new Error(`Agent mailbox message id conflict: ${messageId}`);
    return created;
  }

  async get(sessionId: string, messageId: string): Promise<AgentMailboxMessage | null> {
    const result = await this.executor.query(`SELECT ${SELECT_COLUMNS} FROM agent_mailbox_messages WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3`, [this.tenant(), required(sessionId, "sessionId"), required(messageId, "messageId")]);
    return result.rows[0] ? row(result.rows[0]) : null;
  }

  private async getByTenantMessageId(messageId: string): Promise<AgentMailboxMessage | null> {
    const result = await this.executor.query(`SELECT ${SELECT_COLUMNS} FROM agent_mailbox_messages WHERE tenant_id=$1 AND message_id=$2`, [this.tenant(), required(messageId, "messageId")]);
    return result.rows[0] ? row(result.rows[0]) : null;
  }

  async listPending(input: ListPendingAgentMailboxInput): Promise<AgentMailboxMessage[]> {
    const tenantId = this.tenant();
    const sessionId = required(input.sessionId, "sessionId");
    const now = timestamp(input.now);
    await this.executor.query(
      "UPDATE agent_mailbox_messages SET status='expired',claim_id=NULL,claimed_by=NULL,claim_expires_at=NULL,last_error=COALESCE(last_error,'message expired'),updated_at=$1::timestamptz WHERE tenant_id=$2 AND session_id=$3 AND status IN ('queued','claimed') AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz",
      [now, tenantId, sessionId],
    );
    await this.executor.query(
      "UPDATE agent_mailbox_messages SET status='queued',claim_id=NULL,claimed_by=NULL,claim_expires_at=NULL,updated_at=$1::timestamptz WHERE tenant_id=$2 AND session_id=$3 AND status='claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= $1::timestamptz",
      [now, tenantId, sessionId],
    );
    const params: unknown[] = [tenantId, sessionId, now];
    const clauses = [
      "tenant_id=$1",
      "session_id=$2",
      "status='queued'",
      "available_at <= $3::timestamptz",
      "(expires_at IS NULL OR expires_at > $3::timestamptz)",
    ];
    const add = (column: string, value: string | null | undefined): void => {
      const normalized = value?.trim();
      if (!normalized) return;
      params.push(normalized);
      clauses.push(`${column}=$${params.length}`);
    };
    add("target_run_id", input.targetRunId);
    add("target_agent_call_id", input.targetAgentCallId);
    add("target_thread_key", input.targetThreadKey);
    add("target_child_agent_id", input.targetChildAgentId);
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 100)));
    params.push(limit);
    const result = await this.executor.query(
      `SELECT ${SELECT_COLUMNS} FROM agent_mailbox_messages WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(sent_at, created_at), seq ASC LIMIT $${params.length}`,
      params,
    );
    return result.rows.map(row);
  }

  async claim(input: ClaimAgentMailboxInput): Promise<AgentMailboxMessage[]> {
    const tenantId = this.tenant();
    const sessionId = required(input.sessionId, "sessionId");
    const targetThreadKey = required(input.targetThreadKey, "targetThreadKey");
    const claimId = required(input.claimId, "claimId");
    const consumerId = required(input.consumerId, "consumerId");
    const now = timestamp(input.now);
    const leaseMs = Math.max(1, Math.floor(input.leaseMs ?? 30_000));
    const limit = Math.max(1, Math.min(100, Math.floor(input.limit ?? 20)));
    const claimExpiresAt = new Date(Date.parse(now) + leaseMs).toISOString();
    return this.executor.transaction(async (tx) => {
      await tx.query(`UPDATE agent_mailbox_messages SET status='expired',claim_id=NULL,claimed_by=NULL,claim_expires_at=NULL,last_error=COALESCE(last_error,'message expired'),updated_at=$1::timestamptz WHERE tenant_id=$2 AND session_id=$3 AND status IN ('queued','claimed') AND expires_at IS NOT NULL AND expires_at <= $1::timestamptz`, [now, tenantId, sessionId]);
      await tx.query(`UPDATE agent_mailbox_messages SET status='queued',claim_id=NULL,claimed_by=NULL,claim_expires_at=NULL,updated_at=$1::timestamptz WHERE tenant_id=$2 AND session_id=$3 AND status='claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= $1::timestamptz`, [now, tenantId, sessionId]);
      const existingClaim = await tx.query(
        `SELECT ${SELECT_COLUMNS} FROM agent_mailbox_messages WHERE tenant_id=$1 AND session_id=$2 AND status='claimed' AND claim_id=$3 ORDER BY seq ASC`,
        [tenantId, sessionId, claimId],
      );
      if (existingClaim.rows.length > 0) return existingClaim.rows.map(row);
      const params: unknown[] = [tenantId, sessionId, now];
      const targetRunId = input.targetRunId?.trim() || null;
      const targetChildAgentId = input.targetChildAgentId?.trim() || null;
      const targetAgentCallId = input.targetAgentCallId?.trim() || null;
      let predicate: string;
      if (targetRunId) {
        params.push(targetRunId);
        const activeRunParam = params.length;
        params.push(targetThreadKey);
        const threadParam = params.length;
        predicate = `(target_run_id=$${activeRunParam} AND target_thread_key=$${threadParam}`;
        if (targetAgentCallId) {
          params.push(targetAgentCallId);
          predicate += ` AND target_agent_call_id=$${params.length}`;
        }
        if (targetChildAgentId) {
          params.push(targetChildAgentId);
          predicate += ` AND target_child_agent_id=$${params.length}`;
        }
        params.push(targetThreadKey);
        const idleThreadParam = params.length;
        predicate += ` OR (target_run_id IS NULL AND target_thread_key=$${idleThreadParam}`;
        if (targetAgentCallId) {
          params.push(targetAgentCallId);
          predicate += ` AND (target_agent_call_id IS NULL OR target_agent_call_id=$${params.length})`;
        }
        if (targetChildAgentId) {
          params.push(targetChildAgentId);
          predicate += ` AND target_child_agent_id=$${params.length}`;
        }
        predicate += "))";
      } else {
        params.push(targetThreadKey);
        predicate = `(target_run_id IS NULL AND target_thread_key=$${params.length}`;
        if (targetAgentCallId) {
          params.push(targetAgentCallId);
          predicate += ` AND (target_agent_call_id IS NULL OR target_agent_call_id=$${params.length})`;
        }
        if (targetChildAgentId) {
          params.push(targetChildAgentId);
          predicate += ` AND target_child_agent_id=$${params.length}`;
        }
        predicate += ")";
      }
      params.push(limit);
      const limitParam = params.length;
      const claimed = await tx.query(`
        WITH picked AS (
          SELECT seq,message_id FROM agent_mailbox_messages
          WHERE tenant_id=$1 AND session_id=$2 AND status='queued' AND available_at <= $3::timestamptz
            AND (expires_at IS NULL OR expires_at > $3::timestamptz) AND ${predicate}
          ORDER BY COALESCE(sent_at, created_at), seq ASC FOR UPDATE SKIP LOCKED LIMIT $${limitParam}
        )
        UPDATE agent_mailbox_messages AS message
        SET status='claimed',claim_id=$${limitParam + 1},claimed_by=$${limitParam + 2},claim_expires_at=$${limitParam + 3}::timestamptz,
            attempt_count=message.attempt_count+1,updated_at=$3::timestamptz
        FROM picked WHERE message.tenant_id=$1 AND message.message_id=picked.message_id
        RETURNING ${SELECT_COLUMNS}
      `, [...params, claimId, consumerId, claimExpiresAt]);
      return claimed.rows.map(row);
    });
  }

  async ack(input: AckAgentMailboxInput): Promise<boolean> {
    const result = await this.executor.query("UPDATE agent_mailbox_messages SET status='acked',acked_at=COALESCE(acked_at,CURRENT_TIMESTAMP),claim_id=NULL,claimed_by=NULL,claim_expires_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3 AND status='claimed' AND claim_id=$4", [this.tenant(), required(input.sessionId, "sessionId"), required(input.messageId, "messageId"), required(input.claimId, "claimId")]);
    return Number(result.rowCount ?? 0) > 0;
  }

  async settle(input: SettleAgentMailboxInput): Promise<boolean> {
    const tenantId = this.tenant();
    const sessionId = required(input.sessionId, "sessionId");
    const messageId = required(input.messageId, "messageId");
    const result = await this.executor.query<{ status: string }>(`
      UPDATE agent_mailbox_messages
      SET status='acked',acked_at=COALESCE(acked_at,CURRENT_TIMESTAMP),updated_at=CURRENT_TIMESTAMP,
          claim_id=NULL,claimed_by=NULL,claim_expires_at=NULL
      WHERE tenant_id=$1 AND session_id=$2 AND message_id=$3
        AND status IN ('queued','claimed')
      RETURNING status
    `, [tenantId, sessionId, messageId]);
    if (result.rows[0]?.status === "acked") return true;
    const existing = await this.get(sessionId, messageId);
    return existing?.status === "acked" || existing?.status === "expired";
  }

  async release(input: ReleaseAgentMailboxInput): Promise<boolean> {
    const availableAt = input.availableAt == null ? new Date().toISOString() : timestamp(input.availableAt);
    const result = await this.executor.query("UPDATE agent_mailbox_messages SET status='queued',claim_id=NULL,claimed_by=NULL,claim_expires_at=NULL,available_at=$1::timestamptz,last_error=$2,updated_at=CURRENT_TIMESTAMP WHERE tenant_id=$3 AND session_id=$4 AND message_id=$5 AND status='claimed' AND claim_id=$6", [availableAt, input.lastError ?? null, this.tenant(), required(input.sessionId, "sessionId"), required(input.messageId, "messageId"), required(input.claimId, "claimId")]);
    return Number(result.rowCount ?? 0) > 0;
  }

  async expire(input: { sessionId?: string; now?: string } = {}): Promise<number> {
    const now = timestamp(input.now);
    const params: unknown[] = [this.tenant(), now];
    const sessionClause = input.sessionId?.trim() ? ` AND session_id=$${params.push(input.sessionId.trim())}` : "";
    const result = await this.executor.query(`UPDATE agent_mailbox_messages SET status='expired',claim_id=NULL,claimed_by=NULL,claim_expires_at=NULL,updated_at=$2::timestamptz WHERE tenant_id=$1 AND status IN ('queued','claimed') AND expires_at IS NOT NULL AND expires_at <= $2::timestamptz${sessionClause}`, params);
    return Number(result.rowCount ?? 0);
  }
}
