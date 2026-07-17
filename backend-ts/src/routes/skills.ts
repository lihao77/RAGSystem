import { isRecord } from "../utils/guards.js";
import path from "node:path";
import type { FastifyPluginAsync } from "fastify";

import { ok } from "../contracts/common.js";
import { HttpError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { collectMultipartFiles } from "./file-route-utils.js";
import { requireTenantAdmin, requireTenantMember } from "./tenant-role.js";

interface SkillParams {
  name: string;
}

interface FileQuery {
  path?: string;
}

interface UploadQuery {
  dir?: string;
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
 * Skill 库管理 HTTP 端点。skill 本体是文件系统目录，这里只做受限的目录读写：
- 列/看所有来源 skill（builtin/workspace/user_global）
- 写/删仅限 user_global（service 层硬约束）
 */
export const registerSkillRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/", async (request) => {
    const skills = request.container.skillLibrary.listSkills();
    return ok(skills, `共有 ${skills.length} 个 Skill`);
  });

  app.get<{ Params: SkillParams }>("/:name", async (request) => {
    return ok(request.container.skillLibrary.getSkillDetail(request.params.name), "Skill 详情");
  });

  app.get<{ Params: SkillParams; Querystring: FileQuery }>("/:name/files", async (request, reply) => {
    const rel = request.query.path;
    if (!rel) {
      throw new HttpError(400, "invalid_request", "缺少 path 参数");
    }
    const { buffer, mime } = request.container.skillLibrary.readSkillFile(request.params.name, rel);
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
    const skill = request.container.skillLibrary.createSkill({ name, description, content: asString(request.body.content) ?? "" });
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
    const skill = request.container.skillLibrary.updateSkillMd(request.params.name, patch);
    return ok(skill, `Skill '${skill.name}' 已更新`);
  });

  app.post<{ Params: SkillParams; Querystring: UploadQuery }>("/:name/files", async (request) => {
    requireTenantAdmin(request);
    const parts = await collectMultipartFiles(request);
    const dir = request.query.dir === "scripts" ? "scripts" : "";
    const uploaded = parts.map((part) => {
      const base = path.basename(part.filename);
      const rel = dir ? `${dir}/${base}` : base;
      request.container.skillLibrary.writeSkillFile(request.params.name, rel, part.buffer);
      return { path: rel, bytes: part.buffer.length };
    });
    return ok({ uploaded }, `已上传 ${uploaded.length} 个文件`);
  });

  app.delete<{ Params: SkillParams }>("/:name", async (request) => {
    requireTenantAdmin(request);
    request.container.skillLibrary.deleteSkill(request.params.name);
    return ok({ name: request.params.name }, `Skill '${request.params.name}' 已删除`);
  });
};



function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
