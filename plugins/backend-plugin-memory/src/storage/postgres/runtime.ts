import type { MemoryPluginRuntimeFactory } from "../../dependencies.js";
import { configureMemoryHooks } from "../../runtime-hook.js";
import { createMemoryApplication } from "../../services/memory/memory-application.js";
import { SaaSMemoryToolService } from "../../tools/SaaSMemoryExecution.js";
import { SaaSMemoryContextRepository } from "./memory-context-repository.js";
import { PostgresMemoryRepository, type PostgresMemoryExecutor } from "./repository.js";
import type { ListMemoryCandidatesInput, MemoryCandidateRecord } from "../../contracts/local-candidates.js";

export function createPostgresMemoryRuntimeFactory(options: {
  executor: PostgresMemoryExecutor;
}): MemoryPluginRuntimeFactory {
  const repository = new PostgresMemoryRepository(options.executor);
  return (context) => {
    const application = createMemoryApplication(context.tenantId, repository);
    const contextRepository = new SaaSMemoryContextRepository(application.query);
    return {
      tools: new SaaSMemoryToolService(application, context.sessions),
      createApplication: () => application,
      configureHooks: (registry) => configureMemoryHooks(registry, {
        context,
        repository: contextRepository,
        listCandidates: (input) => listPostgresCandidates(repository, context.tenantId, input),
      }),
    };
  };
}

async function listPostgresCandidates(
  repository: PostgresMemoryRepository,
  tenantId: string,
  query: ListMemoryCandidatesInput,
): Promise<MemoryCandidateRecord[]> {
  const scopes = query.targetScopes ?? (query.targetScope ? [query.targetScope] : ["team", "agent"] as const);
  const rows = await Promise.all(scopes.map(async (scope) => {
    const teamName = query.teamName?.trim() || undefined;
    const agentName = query.agentName?.trim() || undefined;
    const scopeId = scope === "agent"
      ? (teamName && agentName ? JSON.stringify([teamName, agentName]) : undefined)
      : teamName;
    const candidates = await repository.listCandidates({
      tenant_id: tenantId,
      ...(query.ownerUserId ? { owner_user_id: query.ownerUserId } : {}),
      ...(query.statuses ? { statuses: query.statuses } : {}),
      scope,
      ...(scopeId ? { scope_id: scopeId } : {}),
      ...(query.operation ? { operation: query.operation } : {}),
      ...(query.limit !== undefined ? { limit: query.limit } : {}),
      ...(query.offset !== undefined ? { offset: query.offset } : {}),
    });
    return candidates.map((candidate): MemoryCandidateRecord => {
      const parsed = parseAgentScope(candidate.scope, candidate.scope_id);
      return {
        id: candidate.id,
        tenant_id: candidate.tenant_id,
        owner_user_id: candidate.owner_user_id,
        target_scope: candidate.scope === "agent" ? "agent" : "team",
        operation: candidate.operation,
        target_file_name: candidate.target_memory_id,
        team_name: parsed?.[0] ?? candidate.scope_id,
        agent_name: parsed?.[1] ?? null,
        name: candidate.name ?? "",
        description: candidate.description ?? "",
        memory_type: candidate.memory_type ?? "fact",
        content: query.contentMaxChars == null
          ? candidate.content ?? ""
          : (candidate.content ?? "").slice(0, query.contentMaxChars),
        why: candidate.why ?? null,
        how_to_apply: candidate.how_to_apply ?? null,
        status: candidate.status,
        source_session_id: candidate.source_session_id,
        source_run_id: candidate.source_run_id,
        source_message_id: candidate.source_message_id,
        reviewer_user_id: candidate.reviewer_user_id,
        review_comment: candidate.review_comment,
        published_file_name: candidate.published_memory_id,
        created_at: candidate.created_at,
        updated_at: candidate.updated_at,
        reviewed_at: candidate.reviewed_at,
        review_claimed_at: candidate.review_claimed_at ?? null,
        review_attempt_id: candidate.review_claim_token ?? null,
      };
    });
  }));
  return rows.flat()
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at) || right.id.localeCompare(left.id))
    .slice(0, query.limit ?? 100);
}

function parseAgentScope(scope: string, scopeId: string): [string, string] | null {
  if (scope !== "agent" || !scopeId.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(scopeId) as unknown;
    return Array.isArray(parsed) && parsed.length === 2
      ? [String(parsed[0]), String(parsed[1])]
      : null;
  } catch {
    return null;
  }
}
