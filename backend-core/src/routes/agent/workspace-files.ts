import path from "node:path";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";

import { WorkspaceFileListResponseSchema } from "@ragsystem/api-contracts";

import type { WorkspaceFileApplication } from "../../contracts/application/workspace-file-application.js";
import { ok, validateResponse } from "../../contracts/common.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { sendBufferedFileDownload } from "../file-route-utils.js";
import { loadReadableSession } from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";

interface SessionParams { sessionId: string }
interface WorkspaceParams { workspaceId: string }
interface WorkspaceFileQuery { path?: string }

/**
 * 会话内文件可能被后续轮次改写，前端按路径缓存内容，靠 ETag 条件重验证识别变更；
 * 同时显式 no-store 关闭浏览器层缓存——缓存语义只归属前端资源层，避免双层缓存互相干扰。
 */
export const registerWorkspaceFileRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: SessionParams; Querystring: WorkspaceFileQuery }>("/sessions/:sessionId/workspace-files/content", async (request, reply) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    const filePath = request.query.path?.trim();
    if (!filePath) throw new HttpError(400, "invalid_request", "path 参数不能为空");
    const files = await resolveWorkspaceFiles(options, request);
    const result = await files.read(request.params.sessionId, filePath);
    if (result.status === "not_found" || !result.body) {
      throw new HttpError(404, "not_found", "工作空间文件不存在");
    }
    reply.header("cache-control", "private, no-store");
    const etag = normalizeEtagToken(result.etag);
    if (!etag) {
      return sendBufferedFileDownload({
        body: result.body,
        filename: path.posix.basename(result.path ?? filePath.replace(/\\/g, "/")),
        mime: result.contentType ?? "application/octet-stream",
        reply,
      });
    }
    if (etagMatches(request.headers["if-none-match"], etag)) {
      reply.header("etag", quoteEtag(etag));
      return reply.code(304).send();
    }
    reply.header("etag", quoteEtag(etag));
    return sendBufferedFileDownload({
      body: result.body,
      filename: path.posix.basename(result.path ?? filePath.replace(/\\/g, "/")),
      mime: result.contentType ?? "application/octet-stream",
      reply,
    });
  });

  // 项目级文件浏览：按 workspaceId 解析项目根，path 缺省即根目录。
  app.get<{ Params: WorkspaceParams; Querystring: WorkspaceFileQuery }>("/workspaces/:workspaceId/files", async (request) => {
    const files = await resolveWorkspaceFiles(options, request);
    const result = await files.listWorkspaceEntries(request.params.workspaceId, request.query.path ?? "");
    if (result.status === "unsupported") {
      throw new HttpError(501, "not_supported", result.reason ?? "当前部署不支持项目文件浏览");
    }
    if (result.status === "not_found") {
      throw new HttpError(404, "not_found", "项目或目录不存在");
    }
    return validateResponse(WorkspaceFileListResponseSchema, ok({ entries: result.entries, truncated: result.truncated }, "获取项目文件列表成功"));
  });

  app.get<{ Params: WorkspaceParams; Querystring: WorkspaceFileQuery }>("/workspaces/:workspaceId/files/content", async (request, reply) => {
    const files = await resolveWorkspaceFiles(options, request);
    const filePath = request.query.path?.trim();
    if (!filePath) throw new HttpError(400, "invalid_request", "path 参数不能为空");
    const result = await files.readWorkspaceEntry(request.params.workspaceId, filePath);
    if (result.status === "unsupported") {
      throw new HttpError(501, "not_supported", "当前部署不支持项目文件浏览");
    }
    if (result.status === "not_found" || !result.body) {
      throw new HttpError(404, "not_found", "工作空间文件不存在");
    }
    reply.header("cache-control", "private, no-store");
    const etag = normalizeEtagToken(result.etag);
    if (!etag) {
      return sendBufferedFileDownload({
        body: result.body,
        filename: path.posix.basename(result.path ?? filePath.replace(/\\/g, "/")),
        mime: result.contentType ?? "application/octet-stream",
        reply,
      });
    }
    if (etagMatches(request.headers["if-none-match"], etag)) {
      reply.header("etag", quoteEtag(etag));
      return reply.code(304).send();
    }
    reply.header("etag", quoteEtag(etag));
    return sendBufferedFileDownload({
      body: result.body,
      filename: path.posix.basename(result.path ?? filePath.replace(/\\/g, "/")),
      mime: result.contentType ?? "application/octet-stream",
      reply,
    });
  });
};

/** 取裸 token：去空白、弱校验前缀与引号，畸形值视为无版本标识。 */
function normalizeEtagToken(value: string | null | undefined): string {
  const normalized = value?.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1").trim() ?? "";
  return normalized.includes('"') ? "" : normalized;
}

function quoteEtag(etag: string): string {
  return `"${etag}"`;
}

/** If-None-Match 支持 `*` 与逗号分隔列表，逐项剥离 W/ 与引号后比较。 */
function etagMatches(ifNoneMatch: string | string[] | undefined, etag: string): boolean {
  const candidates = Array.isArray(ifNoneMatch) ? ifNoneMatch.join(",") : ifNoneMatch;
  if (!candidates) return false;
  return candidates.split(",").some((candidate) => {
    const token = normalizeEtagToken(candidate);
    return token === "*" || (token !== "" && token === etag);
  });
}

async function resolveWorkspaceFiles(options: RouteOptions, request: FastifyRequest): Promise<WorkspaceFileApplication> {
  const application = await options.resolveWorkspaceFileApplication?.(request);
  if (!application) throw new Error("workspace file application resolver returned no implementation");
  return application;
}
