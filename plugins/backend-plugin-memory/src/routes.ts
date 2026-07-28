import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import type { FastifyRequest } from "fastify";
import type {} from "@ragsystem/backend-core/fastify-context.js";
import { MemoryScopeNameSchema } from "./contracts/memory-store/types.js";
import type { MemoryCandidateStatus } from "./contracts/local-candidates.js";
import type { MemoryApplication } from "./services/memory/index.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { requireTenantAdmin, requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";
import { MEMORY_RUNTIME_CAPABILITY } from "./capability.js";

const CandidateParamsSchema = z.object({ id: z.string().uuid() });
const EntryParamsSchema = z.object({ id: z.string().uuid() });
const EntryArchiveSchema = z.object({ expected_version: z.number().int().positive().optional() });
const EntryQuerySchema = z.object({
  scope: z.string().optional(),
  status: z.enum(["active", "archived"]).optional(),
  search: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
const CandidateQuerySchema = z.object({
  status: z.enum(["candidate", "approved", "rejected", "withdrawn"]).optional(),
  target_scope: z.enum(["team", "agent"]).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  operation: z.enum(["publish", "archive"]).optional(),
});
const UpdateCandidateSchema = z.object({
  expected_version: z.number().int().positive().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.string().min(1).optional(),
  why: z.string().nullable().optional(),
  how_to_apply: z.string().nullable().optional(),
}).refine(
  (value) => value.name !== undefined
    || value.description !== undefined
    || value.content !== undefined
    || value.why !== undefined
    || value.how_to_apply !== undefined,
  "至少提供一个修改字段",
);
const ReviewCandidateSchema = z.object({
  expected_version: z.number().int().positive().optional(),
  review_claim_token: z.string().min(1).optional(),
  comment: z.string().nullable().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.string().min(1).optional(),
});
const MutationCandidateSchema = z.object({
  expected_version: z.number().int().positive().optional(),
});
const ClaimCandidateSchema = z.object({
  expected_version: z.number().int().positive().optional(),
  claim_ttl_seconds: z.number().int().min(1).max(86_400).optional(),
});

function expectedVersion(value: number | undefined, currentVersion: number): number {
  return value ?? currentVersion;
}

async function resolveCandidateVersion(
  memory: MemoryApplication,
  candidateId: string,
  requestedVersion: number | undefined,
  notFoundMessage: string,
): Promise<number> {
  const candidate = await memory.governance.getCandidate(candidateId);
  if (!candidate) throw new HttpError(404, "not_found", notFoundMessage);
  return expectedVersion(requestedVersion, candidate.version);
}

function mutationResult<T extends { outcome: string; candidate?: unknown }>(
  result: T,
  notFoundMessage: string,
): unknown {
  if (result.outcome === "applied") return result.candidate;
  if (result.outcome === "not_found") throw new HttpError(404, "not_found", notFoundMessage);
  throw new HttpError(409, "conflict", "memory 状态已变化，请刷新后重试");
}

async function resolveMemoryApplication(
  request: FastifyRequest,
): Promise<MemoryApplication> {
  const runtime = request.container.pluginCapabilities.require(MEMORY_RUNTIME_CAPABILITY);
  return runtime.createApplication({
    viewerUserId: request.identity.userId,
    viewerSessionIds: () => listOwnedSessionIds(request),
  });
}

export const registerMemoryRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/entries", async (request) => {
    const query = EntryQuerySchema.parse(request.query);
    const scopes = parseEntryScopes(query.scope);
    const ownedSessionIds = await listOwnedSessionIds(request);
    const memory = await resolveMemoryApplication(request);
    const filter = {
      ...(scopes ? { scopes } : {}),
      ...(query.status ? { statuses: [query.status] } : {}),
      ...(query.search ? { search: query.search } : {}),
      viewer_user_id: request.identity.userId,
      viewer_session_ids: ownedSessionIds,
    };
    const [total, items] = await Promise.all([
      memory.query.countManagedEntries(filter),
      memory.query.listManagedEntries({ ...filter, limit: query.limit, offset: query.offset }),
    ]);
    return {
      success: true,
      data: {
        items,
        total,
        limit: query.limit,
        offset: query.offset,
        has_more: query.offset + items.length < total,
      },
    };
  });

  app.post<{ Params: { id: string } }>("/entries/:id/archive", async (request) => {
    const { id } = EntryParamsSchema.parse(request.params);
    const input = EntryArchiveSchema.parse(request.body);
    const memory = await resolveMemoryApplication(request);
    const entry = await memory.query.getEntry(id);
    if (!entry || entry.status !== "active" || !await canManageEntry(request, entry.scope, entry.scope_id)) {
      throw new HttpError(404, "not_found", "memory 不存在或无权归档");
    }
    if (input.expected_version !== undefined && entry.version !== input.expected_version) {
      throw new HttpError(409, "conflict", "memory 状态已变化，请刷新后重试");
    }
    const candidate = await memory.commands.createCandidate({
      scope: entry.scope,
      scope_id: entry.scope_id,
      operation: "archive",
      owner_user_id: request.identity.userId,
      target_memory_id: entry.id,
    });
    if (entry.scope === "team" || entry.scope === "agent") {
      requireTenantAdmin(request);
      return { success: true, data: { status: "candidate", candidate } };
    }
    const archived = await memory.governance.approveCandidate({
      candidate_id: candidate.id,
      reviewer_user_id: request.identity.userId,
      expected_version: candidate.version,
      review_comment: "personal scope archive from Memory manager",
    });
    if (archived.outcome === "target_not_found" || archived.outcome === "not_found") {
      throw new HttpError(404, "not_found", "memory 不存在");
    }
    if (archived.outcome !== "archived") {
      throw new HttpError(409, "conflict", "memory 状态已变化，请刷新后重试");
    }
    return { success: true, data: { status: "archived", entry: archived.memory } };
  });

  app.get("/candidates", async (request) => {
    const query = CandidateQuerySchema.parse(request.query);
    const memory = await resolveMemoryApplication(request);
    const filter = {
      owner_user_id: request.identity.userId,
      ...(query.status ? { statuses: [query.status] } : {}),
      ...(query.target_scope ? { scope: query.target_scope } : {}),
      ...(query.operation ? { operation: query.operation } : {}),
    };
    const [total, items] = await Promise.all([
      memory.governance.countCandidates(filter),
      memory.governance.listCandidates({ ...filter, limit: query.limit, offset: query.offset }),
    ]);
    return { success: true, data: { items, total, limit: query.limit, offset: query.offset, has_more: query.offset + items.length < total } };
  });

  app.patch<{ Params: { id: string } }>("/candidates/:id", async (request) => {
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = UpdateCandidateSchema.parse(request.body);
    const memory = await resolveMemoryApplication(request);
    const version = await resolveCandidateVersion(memory, id, input.expected_version, "memory 不存在或不可修改");
    const result = await memory.commands.updateCandidate({
      candidate_id: id,
      owner_user_id: request.identity.userId,
      expected_version: version,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.how_to_apply !== undefined ? { how_to_apply: input.how_to_apply } : {}),
    });
    return { success: true, data: mutationResult(result, "memory 不存在或不可修改") };
  });

  app.delete<{ Params: { id: string } }>("/candidates/:id", async (request) => {
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = MutationCandidateSchema.parse(request.body ?? {});
    const memory = await resolveMemoryApplication(request);
    const version = await resolveCandidateVersion(memory, id, input.expected_version, "memory 不存在或不可撤回");
    const result = await memory.commands.withdrawCandidate({
      candidate_id: id,
      owner_user_id: request.identity.userId,
      expected_version: version,
    });
    mutationResult(result, "memory 不存在或不可撤回");
    return { success: true };
  });

  app.get("/admin/candidates", async (request) => {
    requireTenantAdmin(request);
    const query = CandidateQuerySchema.parse(request.query);
    const statuses: MemoryCandidateStatus[] = query.status ? [query.status] : ["candidate"];
    const memory = await resolveMemoryApplication(request);
    const filter = {
      statuses,
      scopes: query.target_scope ? ensureGovernedScopes([query.target_scope]) : ["team", "agent"] satisfies Array<"team" | "agent">,
      ...(query.operation ? { operation: query.operation } : {}),
    };
    const [total, items] = await Promise.all([memory.governance.countCandidates(filter), memory.governance.listCandidates({ ...filter, limit: query.limit, offset: query.offset })]);
    return { success: true, data: { items, total, limit: query.limit, offset: query.offset, has_more: query.offset + items.length < total } };
  });

  app.post<{ Params: { id: string } }>("/admin/candidates/:id/claim", async (request) => {
    requireTenantAdmin(request);
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = ClaimCandidateSchema.parse(request.body ?? {});
    const memory = await resolveMemoryApplication(request);
    const candidate = await memory.governance.getCandidate(id);
    requireGovernedCandidate(candidate);
    const result = await memory.governance.claimCandidate({
      candidate_id: id,
      reviewer_user_id: request.identity.userId,
      expected_version: expectedVersion(input.expected_version, candidate.version),
      ...(input.claim_ttl_seconds !== undefined ? { claim_ttl_seconds: input.claim_ttl_seconds } : {}),
    });
    if (result.outcome === "not_found") throw new HttpError(404, "not_found", "待审核 memory 不存在");
    if (result.outcome === "state_conflict") throw new HttpError(409, "conflict", "memory 正在被其他管理员处理或版本已变化");
    return { success: true, data: result };
  });

  app.post<{ Params: { id: string } }>("/admin/candidates/:id/approve", async (request) => {
    requireTenantAdmin(request);
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = ReviewCandidateSchema.parse(request.body ?? {});
    const memory = await resolveMemoryApplication(request);
    let candidate = await memory.governance.getCandidate(id);
    if (!candidate || candidate.status !== "candidate") throw new HttpError(404, "not_found", "待审核 memory 不存在");
    requireGovernedCandidate(candidate);
    let expectedVersionValue = expectedVersion(input.expected_version, candidate.version);
    let claimToken = input.review_claim_token;
    let claimedByThisRequest = false;
    if ((input.name !== undefined || input.description !== undefined || input.content !== undefined)) {
      if (claimToken) throw new HttpError(400, "invalid_request", "已领取的 memory 不能在批准时修改内容");
      const updated = await memory.commands.updateCandidate({
        candidate_id: id,
        owner_user_id: candidate.owner_user_id,
        expected_version: expectedVersionValue,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
      });
      candidate = mutationResult(updated, "待审核 memory 不存在") as typeof candidate;
      expectedVersionValue = candidate.version;
    }
    if (!claimToken) {
      const claimed = await memory.governance.claimCandidate({
        candidate_id: id,
        reviewer_user_id: request.identity.userId,
        expected_version: expectedVersionValue,
      });
      if (claimed.outcome === "not_found") throw new HttpError(404, "not_found", "待审核 memory 不存在");
      if (claimed.outcome === "state_conflict") throw new HttpError(409, "conflict", "memory 正在被其他管理员处理或版本已变化");
      if (claimed.outcome !== "claimed") {
        throw new HttpError(409, "conflict", "memory 正在被其他管理员处理或版本已变化");
      }
      claimToken = claimed.review_claim_token;
      expectedVersionValue = claimed.candidate.version;
      claimedByThisRequest = true;
    }
    if (!claimToken) throw new HttpError(409, "conflict", "memory 审核领取已失效");
    let approved;
    try {
      approved = await memory.governance.approveCandidate({
        candidate_id: id,
        reviewer_user_id: request.identity.userId,
        expected_version: expectedVersionValue,
        review_claim_token: claimToken,
        ...(input.comment !== undefined ? { review_comment: input.comment } : {}),
      });
    } catch (error) {
      if (claimedByThisRequest) {
        await memory.governance.releaseCandidate({
          candidate_id: id,
          reviewer_user_id: request.identity.userId,
          review_claim_token: claimToken,
        }).catch(() => undefined);
      }
      throw error;
    }
    if (claimedByThisRequest && approved.outcome !== "published" && approved.outcome !== "archived") {
      await memory.governance.releaseCandidate({
        candidate_id: id,
        reviewer_user_id: request.identity.userId,
        review_claim_token: claimToken,
      }).catch(() => undefined);
    }
    if (approved.outcome === "not_found") throw new HttpError(404, "not_found", "待审核 memory 不存在");
    if (approved.outcome === "target_not_found") throw new HttpError(404, "not_found", "目标共享 memory 不存在或已归档");
    if (approved.outcome !== "published" && approved.outcome !== "archived") {
      throw new HttpError(409, "conflict", "memory 状态已变化，请刷新后重试");
    }
    return { success: true, data: approved.candidate };
  });

  app.post<{ Params: { id: string } }>("/admin/candidates/:id/reject", async (request) => {
    requireTenantAdmin(request);
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = z.object({
      comment: z.string().nullable().optional(),
      expected_version: z.number().int().positive().optional(),
      review_claim_token: z.string().min(1).optional(),
    }).parse(request.body ?? {});
    const memory = await resolveMemoryApplication(request);
    const candidate = await memory.governance.getCandidate(id);
    requireGovernedCandidate(candidate);
    const expectedVersionValue = expectedVersion(input.expected_version, candidate.version);
    let claimToken = input.review_claim_token;
    let claimedByThisRequest = false;
    if (!claimToken) {
      const claimed = await memory.governance.claimCandidate({
        candidate_id: id,
        reviewer_user_id: request.identity.userId,
        expected_version: expectedVersionValue,
      });
      if (claimed.outcome === "not_found") throw new HttpError(404, "not_found", "待审核 memory 不存在");
      if (claimed.outcome === "state_conflict") throw new HttpError(409, "conflict", "memory 正在被其他管理员处理或版本已变化");
      if (claimed.outcome !== "claimed") {
        throw new HttpError(409, "conflict", "memory 正在被其他管理员处理或版本已变化");
      }
      claimToken = claimed.review_claim_token;
      claimedByThisRequest = true;
    }
    if (!claimToken) throw new HttpError(409, "conflict", "memory 审核领取已失效");
    let rejected;
    try {
      rejected = await memory.governance.rejectCandidate({
        candidate_id: id,
        reviewer_user_id: request.identity.userId,
        review_claim_token: claimToken,
        ...(input.comment !== undefined ? { review_comment: input.comment } : {}),
      });
    } catch (error) {
      if (claimedByThisRequest) {
        await memory.governance.releaseCandidate({
          candidate_id: id,
          reviewer_user_id: request.identity.userId,
          review_claim_token: claimToken,
        }).catch(() => undefined);
      }
      throw error;
    }
    if (claimedByThisRequest && rejected.outcome !== "applied") {
      await memory.governance.releaseCandidate({
        candidate_id: id,
        reviewer_user_id: request.identity.userId,
        review_claim_token: claimToken,
      }).catch(() => undefined);
    }
    return { success: true, data: mutationResult(rejected, "待审核 memory 不存在") };
  });

};

function parseEntryScopes(value: string | undefined): Array<z.infer<typeof MemoryScopeNameSchema>> | undefined {
  if (!value?.trim()) return undefined;
  const scopes = [...new Set(value.split(",").map((scope) => MemoryScopeNameSchema.parse(scope.trim())))];
  return scopes.length ? scopes : undefined;
}

function ensureGovernedScopes(
  scopes: Array<z.infer<typeof MemoryScopeNameSchema>>,
): Array<"team" | "agent"> {
  const governed = scopes.filter((scope): scope is "team" | "agent" => scope === "team" || scope === "agent");
  if (governed.length !== scopes.length) {
    throw new HttpError(400, "invalid_request", "只有 team 和 agent memory 需要管理员审核");
  }
  return governed;
}

function requireGovernedCandidate(
  candidate: Awaited<ReturnType<MemoryApplication["governance"]["getCandidate"]>>,
): asserts candidate is NonNullable<typeof candidate> {
  if (!candidate || candidate.status !== "candidate") {
    throw new HttpError(404, "not_found", "待审核 memory 不存在");
  }
  if (candidate.scope !== "team" && candidate.scope !== "agent") {
    throw new HttpError(400, "invalid_request", "个人 memory 不进入管理员审核");
  }
}

async function listOwnedSessionIds(request: Parameters<typeof requireTenantMember>[0]): Promise<string[]> {
  const sessions = request.container.sessionApplication;
  const ids: string[] = [];
  let cursor = null;
  do {
    const page = await sessions.listSessions({ access: { userId: request.identity.userId, includeTenant: false }, limit: 200, cursor });
    ids.push(...page.items.map((session) => session.session_id));
    cursor = page.nextCursor;
  } while (cursor);
  return ids;
}

async function canManageEntry(
  request: Parameters<typeof requireTenantMember>[0],
  scope: z.infer<typeof MemoryScopeNameSchema>,
  scopeId: string,
): Promise<boolean> {
  if (scope === "team" || scope === "agent") {
    return request.identity.role === "admin" || request.identity.role === "owner";
  }
  if (scope === "user") return scopeId === request.identity.userId;
  if (scope === "session") {
    const sessions = request.container.sessionApplication;
    const session = await sessions.getSession(scopeId);
    return session?.owner_user_id === request.identity.userId;
  }
  try {
    const parts = JSON.parse(scopeId) as unknown;
    return Array.isArray(parts) && parts[0] === request.identity.userId;
  } catch {
    return false;
  }
}
