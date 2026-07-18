import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { MemoryScopeNameSchema } from "../contracts/memory-store/types.js";
import type { MemoryCandidateStatus } from "../contracts/conversation-store/index.js";
import type { MemoryApplication } from "../services/memory/index.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { requireTenantAdmin, requireTenantMember } from "./tenant-role.js";

const CandidateParamsSchema = z.object({ id: z.string().uuid() });
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
  expected_version: z.number().int().positive(),
  claim_ttl_seconds: z.number().int().min(1).max(86_400).optional(),
});

function requireExpectedVersion(value: number | undefined): number {
  if (value === undefined) {
    throw new HttpError(400, "invalid_request", "SaaS memory 操作需要 expected_version");
  }
  return value;
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
  options: RouteOptions,
  request: Parameters<NonNullable<RouteOptions["resolveMemoryApplication"]>>[0],
): Promise<MemoryApplication | undefined> {
  return options.resolveMemoryApplication?.(request);
}

export const registerMemoryRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/candidates", async (request) => {
    const query = CandidateQuerySchema.parse(request.query);
    const memory = await resolveMemoryApplication(options, request);
    if (memory) {
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
    }
    const filter = {
      ownerUserId: request.identity.userId,
      ...(query.status ? { statuses: [query.status] } : {}),
      ...(query.target_scope ? { targetScope: query.target_scope } : {}),
      ...(query.operation ? { operation: query.operation } : {}),
    };
    const total = request.container.conversationStore.countMemoryCandidates(filter);
    const items = request.container.conversationStore.listMemoryCandidates({ ...filter, limit: query.limit, offset: query.offset });
    return { success: true, data: { items, total, limit: query.limit, offset: query.offset, has_more: query.offset + items.length < total } };
  });

  app.patch<{ Params: { id: string } }>("/candidates/:id", async (request) => {
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = UpdateCandidateSchema.parse(request.body);
    const memory = await resolveMemoryApplication(options, request);
    if (memory) {
      const result = await memory.commands.updateCandidate({
        candidate_id: id,
        owner_user_id: request.identity.userId,
        expected_version: requireExpectedVersion(input.expected_version),
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.content !== undefined ? { content: input.content } : {}),
        ...(input.why !== undefined ? { why: input.why } : {}),
        ...(input.how_to_apply !== undefined ? { how_to_apply: input.how_to_apply } : {}),
      });
      return { success: true, data: mutationResult(result, "memory 不存在或不可修改") };
    }
    const update = {
      id,
      ownerUserId: request.identity.userId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.content !== undefined ? { content: input.content } : {}),
      ...(input.why !== undefined ? { why: input.why } : {}),
      ...(input.how_to_apply !== undefined ? { howToApply: input.how_to_apply } : {}),
    };
    const updated = request.container.conversationStore.updateMemoryCandidate(update);
    if (!updated) throw new HttpError(404, "not_found", "memory 不存在或不可修改");
    return { success: true, data: request.container.conversationStore.getMemoryCandidate(id) };
  });

  app.delete<{ Params: { id: string } }>("/candidates/:id", async (request) => {
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = MutationCandidateSchema.parse(request.body ?? {});
    const memory = await resolveMemoryApplication(options, request);
    if (memory) {
      const result = await memory.commands.withdrawCandidate({
        candidate_id: id,
        owner_user_id: request.identity.userId,
        expected_version: requireExpectedVersion(input.expected_version),
      });
      mutationResult(result, "memory 不存在或不可撤回");
      return { success: true };
    }
    const withdrawn = request.container.conversationStore.withdrawMemoryCandidate(id, request.identity.userId);
    if (!withdrawn) throw new HttpError(404, "not_found", "memory 不存在或不可撤回");
    return { success: true };
  });

  app.get("/admin/candidates", async (request) => {
    requireTenantAdmin(request);
    const query = CandidateQuerySchema.parse(request.query);
    const statuses: MemoryCandidateStatus[] = query.status ? [query.status] : ["candidate"];
    const memory = await resolveMemoryApplication(options, request);
    if (memory) {
      const filter = {
        statuses,
        ...(query.target_scope ? { scope: query.target_scope } : {}),
        ...(query.operation ? { operation: query.operation } : {}),
      };
      const [total, items] = await Promise.all([
        memory.governance.countCandidates(filter),
        memory.governance.listCandidates({ ...filter, limit: query.limit, offset: query.offset }),
      ]);
      return { success: true, data: { items, total, limit: query.limit, offset: query.offset, has_more: query.offset + items.length < total } };
    }
    const filter = {
      statuses,
      ...(query.target_scope ? { targetScope: query.target_scope } : {}),
      ...(query.operation ? { operation: query.operation } : {}),
    };
    const total = request.container.conversationStore.countMemoryCandidates(filter);
    const items = request.container.conversationStore.listMemoryCandidates({ ...filter, limit: query.limit, offset: query.offset });
    return { success: true, data: { items, total, limit: query.limit, offset: query.offset, has_more: query.offset + items.length < total } };
  });

  app.post<{ Params: { id: string } }>("/admin/candidates/:id/claim", async (request) => {
    requireTenantAdmin(request);
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = ClaimCandidateSchema.parse(request.body ?? {});
    const memory = await resolveMemoryApplication(options, request);
    if (!memory) throw new HttpError(404, "not_found", "Local memory 不提供独立 claim 接口");
    const result = await memory.governance.claimCandidate({
      candidate_id: id,
      reviewer_user_id: request.identity.userId,
      expected_version: input.expected_version,
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
    const memory = await resolveMemoryApplication(options, request);
    if (memory) {
      let candidate = await memory.governance.getCandidate(id);
      if (!candidate || candidate.status !== "candidate") throw new HttpError(404, "not_found", "待审核 memory 不存在");
      let expectedVersion = requireExpectedVersion(input.expected_version);
      let claimToken = input.review_claim_token;
      let claimedByThisRequest = false;
      if ((input.name !== undefined || input.description !== undefined || input.content !== undefined)) {
        if (claimToken) throw new HttpError(400, "invalid_request", "已领取的 memory 不能在批准时修改内容");
        const updated = await memory.commands.updateCandidate({
          candidate_id: id,
          owner_user_id: candidate.owner_user_id,
          expected_version: expectedVersion,
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.content !== undefined ? { content: input.content } : {}),
        });
        candidate = mutationResult(updated, "待审核 memory 不存在") as typeof candidate;
        expectedVersion = candidate.version;
      }
      if (!claimToken) {
        const claimed = await memory.governance.claimCandidate({
          candidate_id: id,
          reviewer_user_id: request.identity.userId,
          expected_version: expectedVersion,
        });
        if (claimed.outcome === "not_found") throw new HttpError(404, "not_found", "待审核 memory 不存在");
        if (claimed.outcome === "state_conflict") throw new HttpError(409, "conflict", "memory 正在被其他管理员处理或版本已变化");
        if (claimed.outcome !== "claimed") {
          throw new HttpError(409, "conflict", "memory 正在被其他管理员处理或版本已变化");
        }
        claimToken = claimed.review_claim_token;
        expectedVersion = claimed.candidate.version;
        claimedByThisRequest = true;
      }
      if (!claimToken) throw new HttpError(409, "conflict", "memory 审核领取已失效");
      let approved;
      try {
        approved = await memory.governance.approveCandidate({
          candidate_id: id,
          reviewer_user_id: request.identity.userId,
          expected_version: expectedVersion,
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
    }
    const candidate = request.container.conversationStore.getMemoryCandidate(id);
    if (!candidate || candidate.tenant_id !== request.identity.tenantId || candidate.status !== "candidate") {
      throw new HttpError(404, "not_found", "待审核 memory 不存在");
    }
    const claim = request.container.conversationStore.claimMemoryCandidate(id, request.identity.userId);
    if (!claim) {
      throw new HttpError(409, "conflict", "memory 正在被其他管理员处理");
    }
    const scope = MemoryScopeNameSchema.parse(candidate.target_scope);
    if (candidate.operation === "archive") {
      try {
        if (!candidate.target_file_name) throw new HttpError(400, "invalid_request", "归档申请缺少目标文件");
        const archived = await request.container.memoryStore.archiveMemoryWithCommit({
          scope,
          team_name: candidate.team_name,
          agent_name: candidate.agent_name ?? undefined,
        }, candidate.target_file_name, async () => request.container.conversationStore.reviewMemoryCandidate({
          id,
          status: "approved",
          reviewerUserId: request.identity.userId,
          attemptId: claim.attemptId,
          ...(input.comment !== undefined ? { reviewComment: input.comment } : {}),
        }));
        if (!archived) throw new HttpError(404, "not_found", "目标共享 memory 不存在或已归档");
        return { success: true, data: request.container.conversationStore.getMemoryCandidate(id) };
      } catch (error) {
        request.container.conversationStore.releaseMemoryCandidate(id, request.identity.userId, claim.attemptId);
        if (error instanceof Error && error.message === "memory archive state changed before commit") {
          throw new HttpError(409, "conflict", "memory 状态已变化");
        }
        if (error instanceof Error && error.message === "memory entry busy") {
          throw new HttpError(409, "conflict", "目标 memory 正在被其他管理员处理");
        }
        throw error;
      }
    }
    const publishedName = input.name ?? candidate.name;
    const publishedDescription = input.description ?? candidate.description;
    const publishedContent = input.content ?? candidate.content;
    try {
      await request.container.memoryStore.saveMemoryWithCommit({
        scope,
        team_name: candidate.team_name,
        agent_name: candidate.agent_name ?? undefined,
        name: publishedName,
        description: publishedDescription,
        memory_type: candidate.memory_type,
        content: publishedContent,
        why: candidate.why,
        how_to_apply: candidate.how_to_apply,
        source_run_id: candidate.source_run_id,
        source_message_id: candidate.source_message_id,
        status: "active",
      }, async (saved) => request.container.conversationStore.reviewMemoryCandidate({
        id,
        status: "approved",
        reviewerUserId: request.identity.userId,
        attemptId: claim.attemptId,
        ...(input.comment !== undefined ? { reviewComment: input.comment } : {}),
        publishedFileName: saved.file_name,
        publishedName,
        publishedDescription,
        publishedContent,
      }));
    } catch (error) {
      request.container.conversationStore.releaseMemoryCandidate(id, request.identity.userId, claim.attemptId);
      if (error instanceof Error && error.message === "memory publish state changed before commit") {
        throw new HttpError(409, "conflict", "memory 状态已变化");
      }
      if (error instanceof Error && error.message === "memory entry busy") {
        throw new HttpError(409, "conflict", "目标 memory 正在被其他管理员处理");
      }
      throw error;
    }
    return { success: true, data: request.container.conversationStore.getMemoryCandidate(id) };
  });

  app.post<{ Params: { id: string } }>("/admin/candidates/:id/reject", async (request) => {
    requireTenantAdmin(request);
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = z.object({
      comment: z.string().nullable().optional(),
      expected_version: z.number().int().positive().optional(),
      review_claim_token: z.string().min(1).optional(),
    }).parse(request.body ?? {});
    const memory = await resolveMemoryApplication(options, request);
    if (memory) {
      const expectedVersion = requireExpectedVersion(input.expected_version);
      let claimToken = input.review_claim_token;
      let claimedByThisRequest = false;
      if (!claimToken) {
        const claimed = await memory.governance.claimCandidate({
          candidate_id: id,
          reviewer_user_id: request.identity.userId,
          expected_version: expectedVersion,
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
    }
    const candidate = request.container.conversationStore.getMemoryCandidate(id);
    if (!candidate || candidate.tenant_id !== request.identity.tenantId || candidate.status !== "candidate") {
      throw new HttpError(404, "not_found", "待审核 memory 不存在");
    }
    const claim = request.container.conversationStore.claimMemoryCandidate(id, request.identity.userId);
    if (!claim) {
      throw new HttpError(409, "conflict", "memory 正在被其他管理员处理");
    }
    try {
      const rejected = request.container.conversationStore.reviewMemoryCandidate({
        id,
        status: "rejected",
        reviewerUserId: request.identity.userId,
        attemptId: claim.attemptId,
        ...(input.comment !== undefined ? { reviewComment: input.comment } : {}),
      });
      if (rejected) {
        return { success: true, data: request.container.conversationStore.getMemoryCandidate(id) };
      }
    } catch (error) {
      request.container.conversationStore.releaseMemoryCandidate(id, request.identity.userId, claim.attemptId);
      throw error;
    }
    request.container.conversationStore.releaseMemoryCandidate(id, request.identity.userId, claim.attemptId);
    throw new HttpError(409, "conflict", "memory 状态已变化");
  });

};
