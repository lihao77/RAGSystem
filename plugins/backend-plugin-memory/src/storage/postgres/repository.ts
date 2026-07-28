import { randomUUID } from "node:crypto";

import type {
  ApprovePersistedMemoryCandidateInput,
  ClaimPersistedMemoryCandidateInput,
  CreatePersistedMemoryCandidateInput,
  MemoryPartition,
  PersistedMemoryCandidate,
  PersistedMemoryCandidateApprovalResult,
  PersistedMemoryCandidateClaimResult,
  PersistedMemoryCandidateCountOptions,
  PersistedMemoryCandidateListOptions,
  PersistedMemoryCandidateMutationResult,
  PersistedMemoryEntry,
  PersistedMemoryManagementCountOptions,
  PersistedMemoryManagementListOptions,
  PersistedMemoryListOptions,
  RejectPersistedMemoryCandidateInput,
  ReleasePersistedMemoryCandidateInput,
  TransactionalMemoryRepository,
  UpdatePersistedMemoryCandidateInput,
  WithdrawPersistedMemoryCandidateInput,
} from "../../contracts/memory-store/index.js";

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
  review_claim_token: row.review_claim_token == null ? null : String(row.review_claim_token),
  review_claimed_at: row.review_claimed_at == null ? null : new Date(String(row.review_claimed_at)).toISOString(),
});

function candidateWhere(options: PersistedMemoryCandidateCountOptions): { sql: string; params: unknown[] } {
  const clauses = ["tenant_id = $1"];
  const params: unknown[] = [options.tenant_id];
  const add = (clause: string, value: unknown): void => {
    params.push(value);
    clauses.push(`${clause} $${params.length}`);
  };
  if (options.owner_user_id != null) add("owner_user_id =", options.owner_user_id);
  if (options.statuses?.length) {
    params.push(options.statuses);
    clauses.push(`status = ANY($${params.length}::text[])`);
  }
  if (options.scope != null) add("scope =", options.scope);
  if (options.scopes?.length) {
    params.push(options.scopes);
    clauses.push(`scope = ANY($${params.length}::text[])`);
  }
  if (options.scope_id != null) add("scope_id =", options.scope_id);
  if (options.operation != null) add("operation =", options.operation);
  return { sql: clauses.join(" AND "), params };
}

function managedEntryWhere(options: PersistedMemoryManagementCountOptions): { sql: string; params: unknown[] } {
  const clauses = ["tenant_id = $1"];
  const params: unknown[] = [options.tenant_id];
  if (options.scopes?.length) {
    params.push(options.scopes);
    clauses.push(`scope = ANY($${params.length}::text[])`);
  }
  if (options.statuses?.length) {
    params.push(options.statuses);
    clauses.push(`status = ANY($${params.length}::text[])`);
  }
  const search = options.search?.trim();
  if (search) {
    params.push(`%${search}%`);
    clauses.push(`(name ILIKE $${params.length} OR description ILIKE $${params.length} OR content ILIKE $${params.length})`);
  }
  if (options.viewer_user_id) {
    params.push(options.viewer_user_id);
    const userParam = `$${params.length}`;
    params.push(options.viewer_session_ids ?? []);
    const sessionsParam = `$${params.length}`;
    clauses.push(`(
      scope IN ('team', 'agent')
      OR (scope = 'user' AND scope_id = ${userParam})
      OR (CASE WHEN scope = 'workspace' THEN (scope_id::jsonb ->> 0) = ${userParam} ELSE FALSE END)
      OR (scope = 'session' AND scope_id = ANY(${sessionsParam}::text[]))
    )`);
  }
  return { sql: clauses.join(" AND "), params };
}

export class PostgresMemoryRepository implements TransactionalMemoryRepository {
  constructor(private readonly executor: PostgresMemoryExecutor) {}

  private async mutationResult(
    tenantId: string,
    candidateId: string,
    rows: Record<string, unknown>[],
  ): Promise<PersistedMemoryCandidateMutationResult> {
    if (rows[0]) return { outcome: "applied", candidate: candidate(rows[0]) };
    const found = await this.executor.query(
      "SELECT 1 FROM memory_candidates WHERE tenant_id = $1 AND id = $2",
      [tenantId, candidateId],
    );
    return { outcome: found.rows[0] ? "state_conflict" : "not_found" };
  }

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

  async listManagedEntries(options: PersistedMemoryManagementListOptions): Promise<PersistedMemoryEntry[]> {
    const where = managedEntryWhere(options);
    let sql = `SELECT * FROM memory_entries WHERE ${where.sql} ORDER BY updated_at DESC, id DESC`;
    if (options.limit != null) {
      where.params.push(Math.max(1, Math.min(options.limit, 500)));
      sql += ` LIMIT $${where.params.length}`;
    }
    if (options.offset != null) {
      where.params.push(Math.max(0, options.offset));
      sql += ` OFFSET $${where.params.length}`;
    }
    const result = await this.executor.query(sql, where.params);
    return result.rows.map(entry);
  }

  async countManagedEntries(options: PersistedMemoryManagementCountOptions): Promise<number> {
    const where = managedEntryWhere(options);
    const result = await this.executor.query(
      `SELECT COUNT(*) AS total FROM memory_entries WHERE ${where.sql}`,
      where.params,
    );
    return Number(result.rows[0]?.total ?? 0);
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

  async listCandidates(options: PersistedMemoryCandidateListOptions): Promise<PersistedMemoryCandidate[]> {
    const where = candidateWhere(options);
    let sql = `SELECT * FROM memory_candidates WHERE ${where.sql} ORDER BY updated_at DESC, id DESC`;
    if (options.limit != null) {
      where.params.push(Math.max(1, Math.min(options.limit, 500)));
      sql += ` LIMIT $${where.params.length}`;
    }
    if (options.offset != null) {
      where.params.push(Math.max(0, options.offset));
      sql += ` OFFSET $${where.params.length}`;
    }
    const result = await this.executor.query(sql, where.params);
    return result.rows.map(candidate);
  }

  async countCandidates(options: PersistedMemoryCandidateCountOptions): Promise<number> {
    const where = candidateWhere(options);
    const result = await this.executor.query(`SELECT COUNT(*) AS total FROM memory_candidates WHERE ${where.sql}`, where.params);
    return Number(result.rows[0]?.total ?? 0);
  }

  async updateCandidate(input: UpdatePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult> {
    const result = await this.executor.query(
      "UPDATE memory_candidates SET name = COALESCE($1, name), description = COALESCE($2, description), content = COALESCE($3, content), why = CASE WHEN $4 THEN $5 ELSE why END, how_to_apply = CASE WHEN $6 THEN $7 ELSE how_to_apply END, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $8 AND id = $9 AND owner_user_id = $10 AND status = 'candidate' AND review_claim_token IS NULL AND version = $11 RETURNING *",
      [input.name ?? null, input.description ?? null, input.content ?? null, input.why !== undefined, input.why ?? null, input.how_to_apply !== undefined, input.how_to_apply ?? null, input.tenant_id, input.candidate_id, input.owner_user_id, input.expected_version],
    );
    return this.mutationResult(input.tenant_id, input.candidate_id, result.rows);
  }

  async withdrawCandidate(input: WithdrawPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult> {
    const result = await this.executor.query(
      "UPDATE memory_candidates SET status = 'withdrawn', version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND id = $2 AND owner_user_id = $3 AND status = 'candidate' AND review_claim_token IS NULL AND version = $4 RETURNING *",
      [input.tenant_id, input.candidate_id, input.owner_user_id, input.expected_version],
    );
    return this.mutationResult(input.tenant_id, input.candidate_id, result.rows);
  }

  async claimCandidate(input: ClaimPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateClaimResult> {
    const claimToken = randomUUID();
    const ttlSeconds = Math.max(1, Math.min(input.claim_ttl_seconds ?? 900, 86_400));
    const result = await this.executor.query(
      "UPDATE memory_candidates SET reviewer_user_id = $1, review_claim_token = $2, review_claimed_at = CURRENT_TIMESTAMP, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $3 AND id = $4 AND status = 'candidate' AND version = $5 AND (review_claim_token IS NULL OR review_claimed_at < CURRENT_TIMESTAMP - make_interval(secs => $6)) RETURNING *",
      [input.reviewer_user_id, claimToken, input.tenant_id, input.candidate_id, input.expected_version, ttlSeconds],
    );
    if (result.rows[0]) {
      return { outcome: "claimed", candidate: candidate(result.rows[0]), review_claim_token: claimToken };
    }
    const found = await this.executor.query(
      "SELECT 1 FROM memory_candidates WHERE tenant_id = $1 AND id = $2",
      [input.tenant_id, input.candidate_id],
    );
    return { outcome: found.rows[0] ? "state_conflict" : "not_found" };
  }

  async releaseCandidate(input: ReleasePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult> {
    const result = await this.executor.query(
      "UPDATE memory_candidates SET reviewer_user_id = NULL, review_claim_token = NULL, review_claimed_at = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $1 AND id = $2 AND status = 'candidate' AND reviewer_user_id = $3 AND review_claim_token = $4 RETURNING *",
      [input.tenant_id, input.candidate_id, input.reviewer_user_id, input.review_claim_token],
    );
    return this.mutationResult(input.tenant_id, input.candidate_id, result.rows);
  }

  async rejectCandidate(input: RejectPersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateMutationResult> {
    const result = await this.executor.query(
      "UPDATE memory_candidates SET status = 'rejected', review_comment = $1, reviewed_at = CURRENT_TIMESTAMP, review_claim_token = NULL, review_claimed_at = NULL, version = version + 1, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $2 AND id = $3 AND status = 'candidate' AND reviewer_user_id = $4 AND review_claim_token = $5 RETURNING *",
      [input.review_comment ?? null, input.tenant_id, input.candidate_id, input.reviewer_user_id, input.review_claim_token],
    );
    return this.mutationResult(input.tenant_id, input.candidate_id, result.rows);
  }

  async approveCandidate(input: ApprovePersistedMemoryCandidateInput): Promise<PersistedMemoryCandidateApprovalResult> {
    return this.executor.transaction(async (tx) => {
      const found = await tx.query("SELECT * FROM memory_candidates WHERE tenant_id = $1 AND id = $2 FOR UPDATE", [input.tenant_id, input.candidate_id]);
      if (!found.rows[0]) return { outcome: "not_found" };
      const c = candidate(found.rows[0]);
      if (c.status !== "candidate" || c.version !== input.expected_version) return { outcome: "state_conflict" };
      if (c.review_claim_token !== (input.review_claim_token ?? null)
        || (c.review_claim_token != null && c.reviewer_user_id !== input.reviewer_user_id)) {
        return { outcome: "state_conflict" };
      }
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
      const updatedCandidate = await tx.query("UPDATE memory_candidates SET status = 'approved', reviewer_user_id = $1, review_comment = $2, published_memory_id = $3, review_claim_token = NULL, review_claimed_at = NULL, version = version + 1, reviewed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE tenant_id = $4 AND id = $5 AND status = 'candidate' AND version = $6 AND ($7::text IS NULL OR (reviewer_user_id = $1 AND review_claim_token = $7)) RETURNING *", [input.reviewer_user_id, input.review_comment ?? null, memory.id, input.tenant_id, input.candidate_id, input.expected_version, input.review_claim_token ?? null]);
      if (!updatedCandidate.rows[0]) return { outcome: "state_conflict" };
      const revision = await tx.query("INSERT INTO memory_scope_revisions (tenant_id, scope, scope_id, revision) VALUES ($1,$2,$3,1) ON CONFLICT (tenant_id, scope, scope_id) DO UPDATE SET revision = memory_scope_revisions.revision + 1, updated_at = CURRENT_TIMESTAMP RETURNING revision", [c.tenant_id, c.scope, c.scope_id]);
      return { outcome: c.operation === "publish" ? "published" : "archived", candidate: candidate(updatedCandidate.rows[0]), memory, scope_revision: Number(revision.rows[0]?.revision ?? 1) };
    });
  }
}
