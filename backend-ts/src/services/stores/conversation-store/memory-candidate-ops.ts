import { randomUUID } from "node:crypto";

import type {
  CreateMemoryCandidateInput,
  IMemoryCandidateStore,
  MemoryCandidateRecord,
  MemoryCandidateStatus,
} from "../../../contracts/conversation-store/index.js";
import type { ConversationDb } from "./shared/db.js";

const SELECT_COLUMNS = `id, tenant_id, owner_user_id, target_scope, team_name, agent_name,
  operation, target_file_name, name, description, memory_type, content, why, how_to_apply, status,
  source_session_id, source_run_id, source_message_id, reviewer_user_id,
  review_comment, published_file_name, created_at, updated_at, reviewed_at, review_claimed_at,
  review_attempt_id`;

export class MemoryCandidateOps implements IMemoryCandidateStore {
  constructor(private readonly db: ConversationDb) {}

  createMemoryCandidate(input: CreateMemoryCandidateInput): MemoryCandidateRecord {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO memory_candidates (
        id, tenant_id, owner_user_id, target_scope, operation, target_file_name, team_name, agent_name,
        name, description, memory_type, content, why, how_to_apply,
        source_session_id, source_run_id, source_message_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.tenantId, input.ownerUserId, input.targetScope, input.operation ?? "publish", input.targetFileName ?? null, input.teamName,
      input.agentName ?? null, input.name, input.description, input.memoryType,
      input.content, input.why ?? null, input.howToApply ?? null,
      input.sourceSessionId ?? null, input.sourceRunId ?? null, input.sourceMessageId ?? null,
    );
    const record = this.getMemoryCandidate(id);
    if (!record) throw new Error(`memory candidate insert failed: ${id}`);
    return record;
  }

  getMemoryCandidate(id: string): MemoryCandidateRecord | null {
    return this.db.prepare(`SELECT ${SELECT_COLUMNS} FROM memory_candidates WHERE id=?`)
      .get(id) as MemoryCandidateRecord | undefined ?? null;
  }

  listMemoryCandidates(input: {
    ownerUserId?: string | null;
    statuses?: MemoryCandidateStatus[];
    targetScope?: "team" | "agent" | null;
    targetScopes?: Array<"team" | "agent">;
    teamName?: string | null;
    agentName?: string | null;
    operation?: "publish" | "archive" | null;
    limit?: number;
    offset?: number;
    contentMaxChars?: number;
  }): MemoryCandidateRecord[] {
    const query = buildCandidateWhere(input);
    const limit = Math.max(1, Math.min(input.limit ?? 500, 500));
    const offset = Math.max(0, input.offset ?? 0);
    const maxContentChars = input.contentMaxChars === undefined
      ? null
      : Math.max(1, Math.min(input.contentMaxChars, 25_600));
    const columns = maxContentChars === null
      ? SELECT_COLUMNS
      : SELECT_COLUMNS.replace("memory_type, content, why", "memory_type, substr(content, 1, ?) AS content, why");
    const selectParams = maxContentChars === null ? [] : [maxContentChars];
    return this.db.prepare(`SELECT ${columns} FROM memory_candidates${query.where} ORDER BY updated_at DESC, rowid DESC LIMIT ? OFFSET ?`)
      .all(...selectParams, ...query.params, limit, offset) as unknown as MemoryCandidateRecord[];
  }

  countMemoryCandidates(input: {
    ownerUserId?: string | null;
    statuses?: MemoryCandidateStatus[];
    targetScope?: "team" | "agent" | null;
    targetScopes?: Array<"team" | "agent">;
    teamName?: string | null;
    agentName?: string | null;
    operation?: "publish" | "archive" | null;
  }): number {
    const query = buildCandidateWhere(input);
    const row = this.db.prepare(`SELECT COUNT(1) AS total FROM memory_candidates${query.where}`)
      .get(...query.params) as { total: number };
    return Number(row.total);
  }

  claimMemoryCandidate(id: string, reviewerUserId: string): { attemptId: string; claimedAt: string } | null {
    const attemptId = randomUUID();
    const result = this.db.prepare(`
      UPDATE memory_candidates
      SET reviewer_user_id=?, review_attempt_id=?, review_claimed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='candidate'
        AND (reviewer_user_id IS NULL OR review_claimed_at IS NULL OR review_claimed_at < datetime('now', '-15 minutes'))
    `).run(reviewerUserId, attemptId, id);
    if (Number(result.changes) === 0) return null;
    const row = this.db.prepare("SELECT review_claimed_at FROM memory_candidates WHERE id=? AND review_attempt_id=?")
      .get(id, attemptId) as { review_claimed_at: string } | undefined;
    return row ? { attemptId, claimedAt: row.review_claimed_at } : null;
  }

  releaseMemoryCandidate(id: string, reviewerUserId: string, attemptId: string): boolean {
    const result = this.db.prepare(`
      UPDATE memory_candidates
      SET reviewer_user_id=NULL, review_attempt_id=NULL, review_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='candidate' AND reviewer_user_id=? AND review_attempt_id=?
    `).run(id, reviewerUserId, attemptId);
    return Number(result.changes) > 0;
  }

  updateMemoryCandidate(input: {
    id: string;
    ownerUserId: string;
    name?: string;
    description?: string;
    content?: string;
    why?: string | null;
    howToApply?: string | null;
  }): boolean {
    const current = this.getMemoryCandidate(input.id);
    if (!current || current.owner_user_id !== input.ownerUserId || current.status !== "candidate") return false;
    const result = this.db.prepare(`
      UPDATE memory_candidates SET name=?, description=?, content=?, why=?, how_to_apply=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND owner_user_id=? AND status='candidate' AND reviewer_user_id IS NULL
    `).run(
      input.name ?? current.name,
      input.description ?? current.description,
      input.content ?? current.content,
      input.why === undefined ? current.why : input.why,
      input.howToApply === undefined ? current.how_to_apply : input.howToApply,
      input.id,
      input.ownerUserId,
    );
    return Number(result.changes) > 0;
  }

  reviewMemoryCandidate(input: {
    id: string;
    status: "approved" | "rejected";
    reviewerUserId: string;
    attemptId?: string;
    reviewComment?: string | null;
    publishedFileName?: string | null;
    publishedName?: string;
    publishedDescription?: string;
    publishedContent?: string;
  }): boolean {
    const result = this.db.prepare(`
      UPDATE memory_candidates
      SET status=?, reviewer_user_id=?, review_comment=?, published_file_name=?,
          name=COALESCE(?, name), description=COALESCE(?, description), content=COALESCE(?, content),
          reviewed_at=CURRENT_TIMESTAMP, review_claimed_at=NULL, updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='candidate'
        AND ((? IS NULL AND reviewer_user_id IS NULL) OR (reviewer_user_id=? AND review_attempt_id=?))
    `).run(
      input.status,
      input.reviewerUserId,
      input.reviewComment ?? null,
      input.publishedFileName ?? null,
      input.publishedName ?? null,
      input.publishedDescription ?? null,
      input.publishedContent ?? null,
      input.id,
      input.attemptId ?? null,
      input.reviewerUserId,
      input.attemptId ?? null,
    );
    return Number(result.changes) > 0;
  }

  withdrawMemoryCandidate(id: string, ownerUserId: string): boolean {
    const result = this.db.prepare(`
      UPDATE memory_candidates SET status='withdrawn', updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND owner_user_id=? AND status='candidate' AND reviewer_user_id IS NULL
    `).run(id, ownerUserId);
    return Number(result.changes) > 0;
  }
}

function buildCandidateWhere(input: {
  ownerUserId?: string | null;
  statuses?: MemoryCandidateStatus[];
  targetScope?: "team" | "agent" | null;
  targetScopes?: Array<"team" | "agent">;
  teamName?: string | null;
  agentName?: string | null;
  operation?: "publish" | "archive" | null;
}): { where: string; params: string[] } {
  const clauses: string[] = [];
  const params: string[] = [];
  if (input.ownerUserId) { clauses.push("owner_user_id=?"); params.push(input.ownerUserId); }
  if (input.statuses?.length) {
    clauses.push(`status IN (${input.statuses.map(() => "?").join(",")})`);
    params.push(...input.statuses);
  }
  if (input.targetScope) { clauses.push("target_scope=?"); params.push(input.targetScope); }
  if (input.targetScopes?.length) {
    clauses.push(`target_scope IN (${input.targetScopes.map(() => "?").join(",")})`);
    params.push(...input.targetScopes);
  }
  if (input.teamName) { clauses.push("team_name=?"); params.push(input.teamName); }
  if (input.agentName) { clauses.push("agent_name=?"); params.push(input.agentName); }
  if (input.operation) { clauses.push("operation=?"); params.push(input.operation); }
  return { where: clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "", params };
}
