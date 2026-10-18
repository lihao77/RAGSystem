import type { FastifyPluginAsync } from "fastify";

import { ok } from "@ragsystem/backend-core/contracts/common.js";
import { AGENT_CONFIG_CHANGED_EVENT } from "@ragsystem/backend-core/contracts/agent/agent-config-events.js";
import type { BackendPluginEventPublisher } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { requireTenantAdmin, requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";
import type {} from "@ragsystem/backend-core/fastify-context.js";
import { SKILLS_RUNTIME_CAPABILITY } from "./capability.js";
import { z } from "zod";
import { SaveSkillBundleSchema } from "./contracts/skills/skill-bundle.js";

interface SkillParams {
  name: string;
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

interface SkillRouteOptions {
  emitPluginEvent?: BackendPluginEventPublisher;
}

/**
 * Skill 库管理 HTTP 端点。
 * user_global 经 ISkillPackageStore（本地目录包）；builtin/workspace 只读。
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

  app.get<{ Params: SkillParams }>("/:name/bundle", async (request) => {
    return ok(await resolveSkills(request).authoring.getBundle(request.params.name), "Skill 编辑内容");
  });

  app.put<{ Params: SkillParams }>("/:name/bundle", { bodyLimit: 70 * 1024 * 1024 }, async (request) => {
    requireTenantAdmin(request);
    return ok(await resolveSkills(request).authoring.saveBundle(request.params.name, SaveSkillBundleSchema.parse(request.body)), "Skill 已保存并生效");
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

  app.delete<{ Params: SkillParams; Querystring: { expected_revision?: string } }>("/:name", async (request) => {
    requireTenantAdmin(request);
    const skills = resolveSkills(request);
    const deleted = await skills.library.deleteSkill(request.params.name, z.string().regex(/^[a-f0-9]{24,64}$/).parse(request.query.expected_revision));
    return ok(deleted, `Skill '${deleted.name}' 已删除`);
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
