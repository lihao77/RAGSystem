import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";

import { MemoryScopeNameSchema } from "../contracts/memory-store/types.js";
import type { MemoryCandidateStatus } from "../contracts/conversation-store/index.js";
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
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.string().min(1).optional(),
  why: z.string().nullable().optional(),
  how_to_apply: z.string().nullable().optional(),
}).refine((value) => Object.keys(value).length > 0, "至少提供一个修改字段");
const ReviewCandidateSchema = z.object({
  comment: z.string().nullable().optional(),
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  content: z.string().min(1).optional(),
});
export const registerMemoryRoutes: FastifyPluginAsync<RouteOptions> = async (app) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/candidates", async (request) => {
    const query = CandidateQuerySchema.parse(request.query);
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
    const withdrawn = request.container.conversationStore.withdrawMemoryCandidate(id, request.identity.userId);
    if (!withdrawn) throw new HttpError(404, "not_found", "memory 不存在或不可撤回");
    return { success: true };
  });

  app.get("/admin/candidates", async (request) => {
    requireTenantAdmin(request);
    const query = CandidateQuerySchema.parse(request.query);
    const statuses: MemoryCandidateStatus[] = query.status ? [query.status] : ["candidate"];
    const filter = {
      statuses,
      ...(query.target_scope ? { targetScope: query.target_scope } : {}),
      ...(query.operation ? { operation: query.operation } : {}),
    };
    const total = request.container.conversationStore.countMemoryCandidates(filter);
    const items = request.container.conversationStore.listMemoryCandidates({ ...filter, limit: query.limit, offset: query.offset });
    return { success: true, data: { items, total, limit: query.limit, offset: query.offset, has_more: query.offset + items.length < total } };
  });

  app.post<{ Params: { id: string } }>("/admin/candidates/:id/approve", async (request) => {
    requireTenantAdmin(request);
    const { id } = CandidateParamsSchema.parse(request.params);
    const input = ReviewCandidateSchema.parse(request.body ?? {});
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
    const input = z.object({ comment: z.string().nullable().optional() }).parse(request.body ?? {});
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
