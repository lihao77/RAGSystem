import { randomUUID } from "node:crypto";

import type {
  ApprovePersistedMemoryCandidateInput,
  CreatePersistedMemoryCandidateInput,
  MemoryPartition,
  PersistedMemoryCandidate,
  PersistedMemoryCandidateApprovalResult,
  PersistedMemoryEntry,
  PersistedMemoryListOptions,
  TransactionalMemoryRepository,
} from "../../../contracts/memory-store/index.js";

export interface PostgresQueryResult<Row extends Record<string, unknown> = Record<string, unknown>> {
  rows: Row[];
  rowCount?: number;
}

export interface PostgresMemoryExecutor {
  query<Row extends Record<string, unknown> = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<PostgresQueryResult<Row>>;
  transaction<T>(fn: (executor: PostgresMemoryExecutor) => Promise<T>): Promise<T>;
}

const entry = (row: Record<string, unknown>): PersistedMemoryEntry => ({
  tenant_id: String(row.tenant_id), id: String(row.id), scope: row.scope as PersistedMemoryEntry["scope"], scope_id: String(row.scope_id),
  name: String(row.name), description: String(row.description), memory_type: String(row.memory_type), content: String(row.content),
  why: row.why == null ? null : String(row.why), how_to_apply: row.how_to_apply == null ? null : String(row.how_to_apply),
  status: row.status as PersistedMemoryEntry["status"], source_run_id: row.source_run_id == null ? null : String(row.source_run_id),
  source_message_id: row.source_message_id == null ? null : String(row.source_message_id), version: Number(row.version),
  created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString(),
  archived_at: row.archived_at == null ? null : new Date(String(row.archived_at)).toISOString(),
});

const candidate = (row: Record<string, unknown>): PersistedMemoryCandidate => ({
  tenant_id: String(row.tenant_id), id: String(row.id), owner_user_id: String(row.owner_user_id), scope: row.scope as PersistedMemoryCandidate["scope"], scope_id: String(row.scope_id),
  operation: row.operation as PersistedMemoryCandidate["operation"], target_memory_id: row.target_memory_id == null ? null : String(row.target_memory_id),
  name: row.name == null ? null : String(row.name), description: row.description == null ? null : String(row.description), memory_type: row.memory_type == null ? null : String(row.memory_type), content: row.content == null ? null : String(row.content),
  why: row.why == null ? null : String(row.why), how_to_apply: row.how_to_apply == null ? null : String(row.how_to_apply), status: row.status as PersistedMemoryCandidate["status"],
  source_session_id: row.source_session_id == null ? null : String(row.source_session_id), source_run_id: row.source_run_id == null ? null : String(row.source_run_id), source_message_id: row.source_message_id == null ? null : String(row.source_message_id),
  reviewer_user_id: row.reviewer_user_id == null ? null : String(row.reviewer_user_id), review_comment: row.review_comment == null ? null : String(row.review_comment), published_memory_id: row.published_memory_id == null ? null : String(row.published_memory_id),
  version: Number(row.version), created_at: new Date(String(row.created_at)).toISOString(), updated_at: new Date(String(row.updated_at)).toISOString(), reviewed_at: row.reviewed_at == null ? null : new Date(String(row.reviewed_at)).toISOString(),
});

export class PostgresMemoryRepository implements TransactionalMemoryRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  async getEntry(tenantId: string, memoryId: string): Promise<PersistedMemoryEntry | null> {
    const result = await this.executor.query("SELECT * FROM memory_entries WHERE tenant_id = $1 AND id = $2", [tenantId, memoryId]);
    return result.rows[0] ? entry(result.rows[0]) : null;
  }

  async listEntries(partition: MemoryPartition, options: PersistedMemoryListOptions = {}): Promise<PersistedMemoryEntry[]> {
    const params: unknown[] = [partition.tenant_id, partition.scope, partition.scope_id];
    let sql = "SELECT * FROM memory_entries WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3";
    if (!options.include_archived) sql += " AND status = 'active'";
    sql += " ORDER BY updated_at DESC";
    if (options.limit != null) { params.push(options.limit); sql += ` LIMIT $${params.length}`; }
    if (options.offset != null) { params.push(options.offset); sql += ` OFFSET $${params.length}`; }
    const result = await this.executor.query(sql, params);
    return result.rows.map(entry);
  }

  async getScopeRevision(partition: MemoryPartition): Promise<number> {
    const result = await this.executor.query("SELECT revision FROM memory_scope_revisions WHERE tenant_id = $1 AND scope = $2 AND scope_id = $3", [partition.tenant_id, partition.scope, partition.scope_id]);
    return result.rows[0] ? Number(result.rows[0].revision) : 0;
  }

  async createCandidate(input: CreatePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidate> {
    const id = randomUUID();
    const values = [id, input.tenant_id, input.owner_user_id, input.scope, input.scope_id, input.operation,
      input.operation === "archive" ? input.target_memory_id : null, input.operation === "publish" ? input.name : null,
      input.operation === "publish" ? input.description : null, input.operation === "publish" ? input.memory_type : null,
      input.operation === "publish" ? input.content : null, input.operation === "publish" ? input.why ?? null : null,
      input.operation === "publish" ? input.how_to_apply ?? null : null, input.source_session_id ?? null, input.source_run_id ?? null, input.source_message_id ?? null];
    const result = await this.executor.query("INSERT INTO memory_candidates (id, tenant_id, owner_user_id, scope, scope_id, operation, target_memory_id, name, description, memory_type, content, why, how_to_apply, source_session_id, source_run_id, source_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *", values);
    if (!result.rows[0]) throw new Error("memory candidate insert returned no row");
    return candidate(result.rows[0]);
  }

  async getCandidate(tenantId: string, candidateId: string): Promise<PersistedMemoryCandidate | null> {
    const result = await this.executor.query("SELECT * FROM memory_candidates WHERE tenant_id = $1 AND id = $2", [tenantId, candidateId]);
    return result.rows[0] ? candidate(result.rows[0]) : null;
  }

  async approveCandidate(input: ApprovePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateApprovalResult> {
    return this.executor.transaction(async (tx) => {
      const found = await tx.query("SELECT * FROM memory_candidates WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [input.tenant_id, input.candidate_id]);
      if (!found.rows[0]) return { outcome: "not_found" };
      const c = candidate(found.rows[0]);
      if (c.status !== "candidate" || c.version !== input.expected_version) return { outcome: "state_conflict" };
      let memory: PersistedMemoryEntry;
      const now = new Date().toISOString();
      if (c.operation === "archive") {
        const target = await tx.query("SELECT * FROM memory_entries WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [input.tenant_id, c.target_memory_id]);
        if (!target.rows[0] || target.rows[0].status !== "active" || target.rows[0].scope !== c.scope || target.rows[0].scope_id !== c.scope_id) return { outcome: "target_not_found" };
        const updated = await tx.query("UPDATE memory_entries SET status = 'archived', version = version + 1, updated_at = CURRENT_TIMESTAMP, archived_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND id = $2 RETURNING *", [input.tenant_id, c.target_memory_id]);
        const updatedRow = updated.rows[0];
        if (!updatedRow) throw new Error("memory archive update returned no row");
        memory = entry(updatedRow);
      } else {
        const inserted = await tx.query("INSERT INTO memory_entries (id, tenant_id, scope, scope_id, name, description, memory_type, content, why, how_to_apply, source_run_id, source_message_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *", [randomUUID(), c.tenant_id, c.scope, c.scope_id, c.name, c.description, c.memory_type, c.content, c.why, c.how_to_apply, c.source_run_id, c.source_message_id]);
        const insertedRow = inserted.rows[0];
        if (!insertedRow) throw new Error("memory publish insert returned no row");
        memory = entry(insertedRow);
      }
      const updatedCandidate = await tx.query("UPDATE memory_candidates SET status = 'approved', reviewer_user_id = $1, review_comment = $2, published_memory_id = $3, version = version + 1, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $4 AND id = $5 AND status = 'candidate' AND version = $6 RETURNING *", [input.reviewer_user_id, input.review_comment ?? null, memory.id, input.tenant_id, input.candidate_id, input.expected_version]);
      if (!updatedCandidate.rows[0]) return { outcome: "state_conflict" };
      const revision = await tx.query("INSERT INTO memory_scope_revisions (tenant_id, scope, scope_id, revision) VALUES ($1,$2,$3,1) ON CONFLICT (tenant_id, scope, scope_id) DO UPDATE SET revision = memory_scope_revisions.revision + 1, updated_at = CURRENT_TIMESTAMP RETURNING revision", [c.tenant_id, c.scope, c.scope_id]);
      return { outcome: c.operation === "publish" ? "published" : "archived", candidate: candidate(updatedCandidate.rows[0]), memory, scope_revision: Number(revision.rows[0]?.revision ?? 1) };
    });
  }
}
