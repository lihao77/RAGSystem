import type { TransactionalMemoryRepository } from "../../../../contracts/memory-store/index.js";
import type {
  ExecutionMemoryCandidatePort,
  ExecutionMemoryCandidateQuery,
} from "../../../../contracts/execution/execution-storage.js";
import type { TenantId } from "../../../../identity/types.js";

/** Maps tenant PostgreSQL candidates onto the shared execution context contract. */
export class SaaSExecutionMemoryCandidates implements ExecutionMemoryCandidatePort {
  constructor(private readonly tenantId: TenantId, private readonly repository: TransactionalMemoryRepository) {}

  async listMemoryCandidates(query: ExecutionMemoryCandidateQuery) {
    const scopes = query.targetScopes ?? (query.targetScope ? [query.targetScope] : ["team", "agent"] as const);
    const rows = await Promise.all(scopes.map(async (scope) => {
      const teamName = query.teamName?.trim() || undefined;
      const agentName = query.agentName?.trim() || undefined;
      const scopeId = scope === "agent" ? (teamName && agentName ? JSON.stringify([teamName, agentName]) : undefined) : teamName;
      const candidates = await this.repository.listCandidates({
        tenant_id: this.tenantId,
        owner_user_id: query.ownerUserId ?? undefined,
        statuses: query.statuses,
        scope,
        ...(scopeId ? { scope_id: scopeId } : {}),
        operation: query.operation ?? undefined,
        limit: query.limit,
        offset: query.offset,
      });
      return candidates.map((candidate) => {
        const parsed = candidate.scope === "agent" && candidate.scope_id.startsWith("[") ? JSON.parse(candidate.scope_id) as [string, string] : null;
        return {
          id: candidate.id, tenant_id: candidate.tenant_id, owner_user_id: candidate.owner_user_id,
          target_scope: candidate.scope === "agent" ? "agent" as const : "team" as const,
          operation: candidate.operation, target_file_name: candidate.target_memory_id,
          team_name: parsed?.[0] ?? candidate.scope_id, agent_name: parsed?.[1] ?? null,
          name: candidate.name ?? "", description: candidate.description ?? "", memory_type: candidate.memory_type ?? "fact",
          content: query.contentMaxChars == null ? candidate.content ?? "" : (candidate.content ?? "").slice(0, query.contentMaxChars),
          why: candidate.why, how_to_apply: candidate.how_to_apply, status: candidate.status,
          source_session_id: candidate.source_session_id, source_run_id: candidate.source_run_id, source_message_id: candidate.source_message_id,
          reviewer_user_id: candidate.reviewer_user_id, review_comment: candidate.review_comment, published_file_name: candidate.published_memory_id,
          created_at: candidate.created_at, updated_at: candidate.updated_at, reviewed_at: candidate.reviewed_at,
          review_claimed_at: candidate.review_claimed_at ?? null, review_attempt_id: candidate.review_claim_token ?? null,
        };
      });
    }));
    return rows.flat().sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id)).slice(0, query.limit ?? 100);
  }
}
