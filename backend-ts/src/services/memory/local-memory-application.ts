import type { MemoryApplication } from "./memory-application.js";
import type { MemoryStore } from "../../adapters/local/memory-store.js";
import type { ConversationStore, MemoryCandidateRecord } from "../../contracts/conversation-store/index.js";
import type { PersistedMemoryCandidate, PersistedMemoryEntry } from "../../contracts/memory-store/index.js";
import { TenantMemoryQueryService, type MemoryQueryService } from "./query-service.js";
import type { MemoryCommandService } from "./command-service.js";
import type { MemoryGovernanceService } from "./governance-service.js";
import type { MemoryScopeSpec } from "../../contracts/memory-store/types.js";
import type { JsonValue } from "../../contracts/common.js";

/** Adapts Local filesystem memory and SQLite governance records to the async application contract. */
export class LocalMemoryApplication implements MemoryApplication {
  readonly query: MemoryQueryService;
  readonly commands: MemoryCommandService;
  readonly governance: MemoryGovernanceService;

  constructor(private readonly tenantId: string, private readonly memory: MemoryStore, private readonly conversation: ConversationStore) {
    this.query = new LocalQueryService(tenantId, memory);
    this.commands = new LocalCommandService(tenantId, memory, conversation);
    this.governance = new LocalGovernanceService(tenantId, memory, conversation);
  }
}

class LocalQueryService extends TenantMemoryQueryService {
  constructor(private readonly localTenantId: string, private readonly local: MemoryStore) { super(localTenantId, local as never); }
  override async getEntry(memoryId: string): Promise<PersistedMemoryEntry | null> {
    const rows = this.local.listManagedEntries({ tenant_id: this.localTenantId, viewer_user_id: "", viewer_session_ids: [] });
    return rows.find((row) => row.id === memoryId) ?? null;
  }
}

class LocalCommandService implements MemoryCommandService {
  constructor(private readonly tenantId: string, private readonly memory: MemoryStore, private readonly conversation: ConversationStore) {}
  async createCandidate(input: Parameters<MemoryCommandService["createCandidate"]>[0]): Promise<PersistedMemoryCandidate> {
    const value = input as any;
    const candidate = this.conversation.createMemoryCandidate({ tenantId: this.tenantId, ownerUserId: value.owner_user_id, targetScope: value.scope, operation: value.operation, teamName: value.scope_id, ...(value.name !== undefined ? { name: value.name } : { name: `Archive ${value.target_memory_id ?? "memory"}` }), description: value.description ?? "", memoryType: value.memory_type ?? "fact", content: value.content ?? "", ...(value.target_memory_id !== undefined ? { targetFileName: value.target_memory_id } : {}) });
    return toPersistedCandidate(candidate);
  }
  async updateCandidate(input: Parameters<MemoryCommandService["updateCandidate"]>[0]) { const ok = this.conversation.updateMemoryCandidate({ id: input.candidate_id, ownerUserId: input.owner_user_id, ...(input.name !== undefined ? { name: input.name } : {}), ...(input.description !== undefined ? { description: input.description } : {}), ...(input.content !== undefined ? { content: input.content } : {}), ...(input.why !== undefined ? { why: input.why } : {}), ...(input.how_to_apply !== undefined ? { howToApply: input.how_to_apply } : {}) }); return ok ? { outcome: "applied" as const, candidate: toPersistedCandidate(this.conversation.getMemoryCandidate(input.candidate_id)!) } : { outcome: "not_found" as const }; }
  async withdrawCandidate(input: Parameters<MemoryCommandService["withdrawCandidate"]>[0]) { const ok = this.conversation.withdrawMemoryCandidate(input.candidate_id, input.owner_user_id); return ok ? { outcome: "applied" as const, candidate: toPersistedCandidate(this.conversation.getMemoryCandidate(input.candidate_id)!) } : { outcome: "not_found" as const }; }
}

class LocalGovernanceService implements MemoryGovernanceService {
  constructor(private readonly tenantId: string, private readonly memory: MemoryStore, private readonly conversation: ConversationStore) {}
  async getCandidate(id: string) { const row = this.conversation.getMemoryCandidate(id); return row && row.tenant_id === this.tenantId ? toPersistedCandidate(row) : null; }
  async listCandidates(query: Parameters<MemoryGovernanceService["listCandidates"]>[0] = {}) { const q = query as any; return this.conversation.listMemoryCandidates({ ...(q.owner_user_id !== undefined ? { ownerUserId: q.owner_user_id } : {}), ...(q.statuses ? { statuses: q.statuses } : {}), ...(q.scope ? { targetScope: q.scope } : {}), ...(q.scopes ? { targetScopes: q.scopes.filter((s: string) => s === "team" || s === "agent") } : {}), ...(q.operation ? { operation: q.operation } : {}), ...(q.limit !== undefined ? { limit: q.limit } : {}), ...(q.offset !== undefined ? { offset: q.offset } : {}) }).filter((row) => row.tenant_id === this.tenantId).map(toPersistedCandidate); }
  async countCandidates(query: Parameters<MemoryGovernanceService["countCandidates"]>[0] = {}) { const q = query as any; return this.conversation.countMemoryCandidates({ ...(q.owner_user_id !== undefined ? { ownerUserId: q.owner_user_id } : {}), ...(q.statuses ? { statuses: q.statuses } : {}), ...(q.scope ? { targetScope: q.scope } : {}), ...(q.scopes ? { targetScopes: q.scopes.filter((s: string) => s === "team" || s === "agent") } : {}), ...(q.operation ? { operation: q.operation } : {}) }); }
  async claimCandidate(input: Parameters<MemoryGovernanceService["claimCandidate"]>[0]) { const claim = this.conversation.claimMemoryCandidate(input.candidate_id, input.reviewer_user_id); return claim ? { outcome: "claimed" as const, candidate: toPersistedCandidate(this.conversation.getMemoryCandidate(input.candidate_id)!), review_claim_token: claim.attemptId } : { outcome: "state_conflict" as const }; }
  async releaseCandidate(input: Parameters<MemoryGovernanceService["releaseCandidate"]>[0]) { const ok = this.conversation.releaseMemoryCandidate(input.candidate_id, input.reviewer_user_id, input.review_claim_token); return ok ? { outcome: "applied" as const, candidate: toPersistedCandidate(this.conversation.getMemoryCandidate(input.candidate_id)!) } : { outcome: "state_conflict" as const }; }
  async rejectCandidate(input: Parameters<MemoryGovernanceService["rejectCandidate"]>[0]) { const ok = this.conversation.reviewMemoryCandidate({ id: input.candidate_id, status: "rejected", reviewerUserId: input.reviewer_user_id, attemptId: input.review_claim_token, ...(input.review_comment !== undefined ? { reviewComment: input.review_comment } : {}) }); return ok ? { outcome: "applied" as const, candidate: toPersistedCandidate(this.conversation.getMemoryCandidate(input.candidate_id)!) } : { outcome: "state_conflict" as const }; }
  async approveCandidate(input: Parameters<MemoryGovernanceService["approveCandidate"]>[0]) {
    const row = this.conversation.getMemoryCandidate(input.candidate_id); if (!row) return { outcome: "not_found" as const };
    const ok = this.conversation.reviewMemoryCandidate({ id: input.candidate_id, status: "approved", reviewerUserId: input.reviewer_user_id, ...(input.review_claim_token ? { attemptId: input.review_claim_token } : {}) });
    if (!ok) return { outcome: "state_conflict" as const };
    const candidate = toPersistedCandidate(this.conversation.getMemoryCandidate(input.candidate_id)!);
    if (row.operation === "archive") {
      const spec = toScope(row); const archived = await this.memory.archiveMemory(spec, row.target_file_name ?? "");
      if (!archived) return { outcome: "target_not_found" as const };
      return { outcome: "archived" as const, candidate, memory: toArchivedEntry(candidate) , scope_revision: 0 };
    }
    const saved = await this.memory.saveMemory({ scope: row.target_scope === "agent" ? "agent" : "team", team_name: row.team_name, ...(row.agent_name ? { agent_name: row.agent_name } : {}), name: row.name, description: row.description, content: row.content, memory_type: row.memory_type, why: row.why, how_to_apply: row.how_to_apply });
    return { outcome: "published" as const, candidate, memory: { ...toArchivedEntry(candidate), id: saved.file_name }, scope_revision: 0 };
  }
}

function toPersistedCandidate(row: MemoryCandidateRecord): PersistedMemoryCandidate { return { tenant_id: row.tenant_id, scope: row.target_scope, scope_id: row.team_name, id: row.id, owner_user_id: row.owner_user_id, operation: row.operation, target_memory_id: null, name: row.name, description: row.description, memory_type: row.memory_type, content: row.content, why: row.why, how_to_apply: row.how_to_apply, status: row.status, source_session_id: row.source_session_id, source_run_id: row.source_run_id, source_message_id: row.source_message_id, reviewer_user_id: row.reviewer_user_id, review_comment: row.review_comment, published_memory_id: row.published_file_name, version: 1, created_at: row.created_at, updated_at: row.updated_at, reviewed_at: row.reviewed_at, review_claim_token: row.review_attempt_id, review_claimed_at: row.review_claimed_at }; }
function toScope(row: MemoryCandidateRecord): MemoryScopeSpec { return row.target_scope === "agent" ? { scope: "agent", team_name: row.team_name, agent_name: row.agent_name ?? "" } : { scope: "team", team_name: row.team_name }; }
function toArchivedEntry(candidate: PersistedMemoryCandidate): PersistedMemoryEntry { return { tenant_id: candidate.tenant_id, scope: candidate.scope, scope_id: candidate.scope_id, id: candidate.target_memory_id ?? candidate.id, name: candidate.name ?? "", description: candidate.description ?? "", memory_type: candidate.memory_type ?? "fact", content: candidate.content ?? "", why: candidate.why, how_to_apply: candidate.how_to_apply, status: "archived", source_run_id: candidate.source_run_id, source_message_id: candidate.source_message_id, version: 1, created_at: candidate.created_at, updated_at: candidate.updated_at, archived_at: candidate.updated_at }; }
