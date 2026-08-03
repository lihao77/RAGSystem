import type { FastifyPluginAsync } from "fastify";

import { ok } from "@ragsystem/backend-core/contracts/common.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { requireTenantAdmin, requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";
import type {} from "@ragsystem/backend-core/fastify-context.js";
import { SKILLS_RUNTIME_CAPABILITY } from "./capability.js";
import {
  DeleteSkillDraftSchema,
  PublishSkillDraftSchema,
  SubmitSkillArtifactSchema,
  toSkillDraftView,
} from "./contracts/skills/skill-draft.js";

interface SkillParams {
  name: string;
}

interface DraftParams {
  id: string;
}

interface FileQuery {
  path?: string;
}

interface AvailableQuery {
  workspace_root?: string;
}

interface AgentParams {
  agentName: string;
}

interface TeamQuery {
  team?: string;
}

interface SubmitArtifactBody {
  artifact_id: string;
  expected_revision: number;
  session_id: string;
  name?: string;
  description?: string;
}

/**
 * Skill 库管理 HTTP 端点。
 * user_global 经 ISkillPackageStore（Local 文件 / SaaS PG+对象存储）；builtin/workspace 只读。
 */
export const registerSkillRoutes: FastifyPluginAsync = async (app) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/", async (request) => {
    const skills = await resolveSkills(request).library.listSkills();
    return ok(skills, `共有 ${skills.length} 个 Skill`);
  });

  app.get<{ Querystring: AvailableQuery }>("/available", async (request) => {
    const skills = await resolveSkills(request).tools.listAvailableSkillsAsync(request.query.workspace_root);
    return ok(skills, `共有 ${skills.length} 个可用 Skill`);
  });

  app.get<{ Params: AgentParams; Querystring: TeamQuery }>("/agents/:agentName/config", async (request) => {
    return ok(await resolveSkills(request).agentConfig.getEffective(configKey(request.params, request.query)), "Skills Agent 配置");
  });

  app.put<{ Params: AgentParams; Querystring: TeamQuery }>("/agents/:agentName/config", async (request) => {
    requireTenantAdmin(request);
    return ok(await resolveSkills(request).agentConfig.put(configKey(request.params, request.query), request.body), "Skills Agent 配置已更新");
  });

  app.delete<{ Params: AgentParams; Querystring: TeamQuery }>("/agents/:agentName/config", async (request) => {
    requireTenantAdmin(request);
    return ok(await resolveSkills(request).agentConfig.delete(configKey(request.params, request.query)), "Skills Agent 配置已重置");
  });

  app.get("/drafts", async (request) => {
    return ok(await resolveSkills(request).authoring.listDraftViews(), "Skill candidates");
  });

  app.get<{ Params: DraftParams }>("/drafts/:id", async (request) => {
    return ok(await resolveSkills(request).authoring.getDraftView(request.params.id), "Skill candidate");
  });

  app.post<{ Body: SubmitArtifactBody }>("/drafts/import", async (request) => {
    requireTenantMember(request);
    const body = SubmitSkillArtifactSchema.parse(request.body);
    const sessionId = body.session_id;
    if (!sessionId) throw new HttpError(400, "invalid_request", "session_id is required");
    await resolveArtifactResource(request).assertReadable(request, sessionId);
    const candidate = await resolveSkills(request).authoring.submitArtifact(
      body.artifact_id,
      body.expected_revision,
      {
        sourceSessionId: sessionId,
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description } : {}),
      },
    );
    return ok(toSkillDraftView(candidate, "not_published"), "Skill Artifact 已复制为候选");
  });

  app.post<{ Params: DraftParams }>("/drafts/:id/publish", async (request) => {
    requireTenantAdmin(request);
    const input = PublishSkillDraftSchema.parse(request.body);
    const published = await resolveSkills(request).authoring.publishDraft(request.params.id, input.expected_revision);
    return ok(toSkillDraftView(published, "available"), "Skill draft published");
  });

  app.delete<{ Params: DraftParams }>("/drafts/:id", async (request) => {
    requireTenantAdmin(request);
    const input = DeleteSkillDraftSchema.parse(request.body);
    return ok(
      await resolveSkills(request).authoring.deleteDraft(request.params.id, input.expected_revision),
      "Skill draft deleted",
    );
  });

  app.get<{ Params: SkillParams }>("/:name", async (request) => {
    return ok(await resolveSkills(request).library.getSkillDetail(request.params.name), "Skill 详情");
  });

  app.get<{ Params: SkillParams; Querystring: FileQuery }>("/:name/files", async (request, reply) => {
    const rel = request.query.path;
    if (!rel) {
      throw new HttpError(400, "invalid_request", "缺少 path 参数");
    }
    const { buffer, mime } = await resolveSkills(request).library.readSkillFile(request.params.name, rel);
    reply.header("content-type", mime);
    return buffer;
  });

  app.delete<{ Params: SkillParams }>("/:name", async (request) => {
    requireTenantAdmin(request);
    const skills = resolveSkills(request);
    const deleted = await skills.library.deleteSkill(request.params.name);
    const restoredCandidate = await skills.authoring.restoreCandidateAfterReleaseDelete(deleted.name);
    return ok({
      ...deleted,
      restored_candidate: restoredCandidate
        ? toSkillDraftView(restoredCandidate, "not_published")
        : null,
    }, `Skill '${deleted.name}' 已删除`);
  });
};

function resolveSkills(request: Parameters<typeof requireTenantMember>[0]) {
  return request.container.pluginCapabilities.require(SKILLS_RUNTIME_CAPABILITY);
}

function resolveArtifactResource(request: Parameters<typeof requireTenantMember>[0]) {
  const resource = request.container.pluginCapabilities.require(SKILLS_RUNTIME_CAPABILITY).artifactResource;
  if (!resource) throw new HttpError(503, "dependency_unavailable", "Artifact 插件未启用，无法提交 Skill Artifact");
  return resource;
}

function configKey(params: AgentParams, query: TeamQuery): { teamName: string; agentName: string } {
  return {
    teamName: query.team?.trim() || "default",
    agentName: params.agentName,
  };
}
