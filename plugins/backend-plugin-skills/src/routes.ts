import { isRecord } from "@ragsystem/backend-core/utils/guards.js";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";

import { ok } from "@ragsystem/backend-core/contracts/common.js";
import { HttpError } from "@ragsystem/backend-core/utils/errors.js";
import { collectMultipartFiles } from "@ragsystem/backend-core/routes/file-route-utils.js";
import { requireTenantAdmin, requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";
import type {} from "@ragsystem/backend-core/fastify-context.js";
import { SKILLS_RUNTIME_CAPABILITY } from "./capability.js";

interface SkillParams {
  name: string;
}

interface FileQuery {
  path?: string;
}

interface UploadQuery {
  dir?: string;
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

interface CreateBody {
  name?: unknown;
  description?: unknown;
  content?: unknown;
}

interface UpdateBody {
  description?: unknown;
  content?: unknown;
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

  app.post<{ Body: CreateBody }>("/", async (request) => {
    requireTenantAdmin(request);
    if (!isRecord(request.body)) {
      throw new HttpError(400, "invalid_request", "请求体必须是对象");
    }
    const name = asString(request.body.name);
    const description = asString(request.body.description);
    if (!name || !description) {
      throw new HttpError(400, "invalid_request", "name 与 description 必填");
    }
    const skill = await resolveSkills(request).library.createSkill({
      name,
      description,
      content: asString(request.body.content) ?? "",
    });
    return ok(skill, `Skill '${skill.name}' 已创建`);
  });

  app.put<{ Params: SkillParams; Body: UpdateBody }>("/:name", async (request) => {
    requireTenantAdmin(request);
    if (!isRecord(request.body)) {
      throw new HttpError(400, "invalid_request", "请求体必须是对象");
    }
    const patch: { description?: string; content?: string } = {};
    const description = asString(request.body.description);
    if (description) {
      patch.description = description;
    }
    const content = asString(request.body.content);
    if (content !== null) {
      patch.content = content;
    }
    const skill = await resolveSkills(request).library.updateSkillMd(request.params.name, patch);
    return ok(skill, `Skill '${skill.name}' 已更新`);
  });

  app.post<{ Params: SkillParams; Querystring: UploadQuery }>("/:name/files", async (request) => {
    requireTenantAdmin(request);
    const parts = await collectMultipartFiles(request);
    const dir = request.query.dir === "scripts" ? "scripts" : "";
    const uploaded = [];
    for (const part of parts) {
      const base = path.basename(part.filename);
      const rel = dir ? `${dir}/${base}` : base;
      await resolveSkills(request).library.writeSkillFile(request.params.name, rel, part.buffer);
      uploaded.push({ path: rel, bytes: part.buffer.length });
    }
    return ok({ uploaded }, `已上传 ${uploaded.length} 个文件`);
  });

  app.delete<{ Params: SkillParams }>("/:name", async (request) => {
    requireTenantAdmin(request);
    await resolveSkills(request).library.deleteSkill(request.params.name);
    return ok({ name: request.params.name }, `Skill '${request.params.name}' 已删除`);
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

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
