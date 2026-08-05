import type { FastifyPluginAsync } from "fastify";

import { ok } from "@ragsystem/backend-core/contracts/common.js";
import { AGENT_CONFIG_CHANGED_EVENT } from "@ragsystem/backend-core/contracts/agent/agent-config-events.js";
import type { BackendPluginEventPublisher } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { requireTenantAdmin, requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";
import type {} from "@ragsystem/backend-core/fastify-context.js";
import { SKILLS_RUNTIME_CAPABILITY } from "./capability.js";
import {
  CreateSkillDraftSchema,
  DeleteSkillDraftFileQuerySchema,
  PublishSkillDraftSchema,
  PutSkillDraftFileSchema,
  toSkillDraftView,
  UpdateSkillDraftSchema,
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

interface DraftFileQuery {
  path?: string;
  expected_revision?: string;
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

interface SkillRouteOptions {
  emitPluginEvent?: BackendPluginEventPublisher;
}

/**
 * Skill 库管理 HTTP 端点。
 * user_global 经 ISkillPackageStore（Local 文件 / SaaS PG+对象存储）；builtin/workspace 只读。
 */
export const registerSkillRoutes: FastifyPluginAsync<SkillRouteOptions> = async (app, options) => {
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
    const key = configKey(request.params, request.query);
    const result = await resolveSkills(request).agentConfig.put(key, request.body);
    await options.emitPluginEvent?.(AGENT_CONFIG_CHANGED_EVENT, {
      tenantId: request.tenantId,
      teamName: key.teamName,
      change: "updated",
    });
    return ok(result, "Skills Agent 配置已更新");
  });

  app.delete<{ Params: AgentParams; Querystring: TeamQuery }>("/agents/:agentName/config", async (request) => {
    requireTenantAdmin(request);
    const key = configKey(request.params, request.query);
    const result = await resolveSkills(request).agentConfig.delete(key);
    await options.emitPluginEvent?.(AGENT_CONFIG_CHANGED_EVENT, {
      tenantId: request.tenantId,
      teamName: key.teamName,
      change: "updated",
    });
    return ok(result, "Skills Agent 配置已重置");
  });

  app.get("/drafts", async (request) => {
    return ok(await resolveSkills(request).authoring.listDraftViews(), "Skill drafts");
  });

  app.post("/drafts", async (request) => {
    requireTenantAdmin(request);
    const input = CreateSkillDraftSchema.parse(request.body);
    const authoring = resolveSkills(request).authoring;
    const draft = await authoring.createDraftForEditing(input.name, input.description);
    return ok(await authoring.getDraftView(draft.id), "Skill draft created");
  });

  app.get<{ Params: DraftParams }>("/drafts/:id", async (request) => {
    return ok(await resolveSkills(request).authoring.getDraftView(request.params.id), "Skill draft");
  });

  app.put<{ Params: DraftParams }>("/drafts/:id", async (request) => {
    requireTenantAdmin(request);
    const input = UpdateSkillDraftSchema.parse(request.body);
    const authoring = resolveSkills(request).authoring;
    const { expected_revision: expectedRevision, ...content } = input;
    const updated = await authoring.updateDraft(request.params.id, expectedRevision, content);
    return ok(await authoring.getDraftView(updated.id), "Skill draft updated");
  });

  app.get<{ Params: DraftParams; Querystring: FileQuery }>("/drafts/:id/files", async (request) => {
    const relativePath = request.query.path?.trim();
    if (!relativePath) throw new HttpError(400, "invalid_request", "Missing path query parameter");
    return ok(
      await resolveSkills(request).authoring.getDraftFile(request.params.id, relativePath),
      "Skill draft file",
    );
  });

  app.put<{ Params: DraftParams }>("/drafts/:id/files", { bodyLimit: 70 * 1024 * 1024 }, async (request) => {
    requireTenantAdmin(request);
    const input = PutSkillDraftFileSchema.parse(request.body);
    const updated = await resolveSkills(request).authoring.putDraftFile(
      request.params.id,
      input.expected_revision,
      input,
    );
    return ok(await resolveSkills(request).authoring.getDraftView(updated.id), "Skill draft file saved");
  });

  app.delete<{ Params: DraftParams; Querystring: DraftFileQuery }>("/drafts/:id/files", async (request) => {
    requireTenantAdmin(request);
    const input = DeleteSkillDraftFileQuerySchema.parse(request.query);
    const updated = await resolveSkills(request).authoring.deleteDraftFile(
      request.params.id,
      input.expected_revision,
      input.path,
    );
    return ok(await resolveSkills(request).authoring.getDraftView(updated.id), "Skill draft file deleted");
  });

  app.post<{ Params: DraftParams }>("/drafts/:id/publish", async (request) => {
    requireTenantAdmin(request);
    const input = PublishSkillDraftSchema.parse(request.body);
    const published = await resolveSkills(request).authoring.publishDraft(request.params.id, input.expected_revision);
    return ok(toSkillDraftView(published, "available"), "Skill draft published");
  });

  app.delete<{ Params: DraftParams }>("/drafts/:id", async (request) => {
    requireTenantAdmin(request);
    return ok(
      await resolveSkills(request).authoring.deleteDraft(request.params.id),
      "Skill draft deleted",
    );
  });

  app.post<{ Params: SkillParams }>("/:name/draft", async (request) => {
    requireTenantAdmin(request);
    const authoring = resolveSkills(request).authoring;
    const draft = await authoring.ensureDraftForPublishedSkill(request.params.name);
    return ok(await authoring.getDraftView(draft.id), "Skill draft ready for editing");
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
    const restoredCandidate = await skills.authoring.restoreDraftAfterSkillDelete(deleted.name);
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

function configKey(params: AgentParams, query: TeamQuery): { teamName: string; agentName: string } {
  return {
    teamName: query.team?.trim() || "default",
    agentName: params.agentName,
  };
}
