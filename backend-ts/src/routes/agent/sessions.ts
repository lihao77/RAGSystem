import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import {
  CreateSessionResponseSchema,
  SessionDetailResponseSchema,
  SessionListResponseSchema,
  SessionMessageListResponseSchema,
  SessionMessageRunStepsResponseSchema,
  SessionPermissionResponseSchema,
  SessionWsTicketResponseSchema,
  UpdateSessionPermissionModeRequestSchema,
} from "@ragsystem/api-contracts";

import { ok, validateResponse } from "../../contracts/common.js";
import type { AttachmentRef } from "../../contracts/execution/execution.js";
import {
  CreateSessionRequestSchema,
  RollbackAndRetryRequestSchema,
  RollbackRequestSchema,
  UpdateMessageRequestSchema,
} from "../../contracts/session/session.js";
import { HttpError } from "../../utils/errors.js";
import { ensureRequestApplications } from "../../app/request-applications.js";
import type { AgentRouteOptions } from "../route-options.js";
import { ZodError } from "zod";
import { WorkspaceRootValidationError } from "../../services/sessions/index.js";
import { assertSessionOwner, loadOwnedSession } from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";

interface SessionParams {
  sessionId: string;
}

interface MessageParams extends SessionParams {
  messageId: string;
}

export const registerSessionRoutes: FastifyPluginAsync<AgentRouteOptions> = async (app, options) => {
  app.post("/sessions", async (request) => {
    const payload = CreateSessionRequestSchema.parse(request.body);
    try {
      const sessions = await resolveSessionApplication(options, request);
      const session = await sessions.createSession({
        sessionId: payload.session_id?.trim() || randomUUID(), userId: request.identity.userId,
        permissionMode: payload.permission_mode ?? null, ...(payload.metadata ? { metadata: payload.metadata } : {}),
      });
      return validateResponse(CreateSessionResponseSchema, ok(session, "会话创建成功"));
    } catch (error) {
      if (error instanceof WorkspaceRootValidationError) {
        throw new HttpError(400, "invalid_request", error.message);
      }
      throw error;
    }
  });

  app.get("/sessions", async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = clampInt(query.limit, 20, 1, 200);
    const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const botIds = await options.botRepository.listOwnedBotIdsForTenant(
      request.identity.userId,
      request.identity.tenantId,
    );
    const application = await resolveSessionApplication(options, request);
    const sessions = await application.listSessions({
      limit, offset, userIds: [request.identity.userId, ...botIds],
    });
    return validateResponse(SessionListResponseSchema, ok(sessions, "获取会话列表成功"));
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const session = await sessions.getSession(request.params.sessionId);
    if (!session) throw new HttpError(404, "not_found", "会话不存在");
    await assertSessionOwner(request, session);
    return validateResponse(SessionDetailResponseSchema, ok(session, "获取会话成功"));
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/ws-ticket", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, request.params.sessionId, sessions);
    return validateResponse(
      SessionWsTicketResponseSchema,
      ok(options.wsTickets.issue(request.identity, request.params.sessionId), "WebSocket ticket 已签发"),
    );
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/permissions", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const session = await loadOwnedSession(request, request.params.sessionId, sessions);
    return validateResponse(
      SessionPermissionResponseSchema,
      ok({ mode: session.permission_mode ?? "standard" }, "获取会话权限成功"),
    );
  });

  app.patch<{ Params: SessionParams }>("/sessions/:sessionId/permissions", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, request.params.sessionId, sessions);
    const payload = UpdateSessionPermissionModeRequestSchema.parse(request.body);
    const updated = await sessions.updateSessionPermissionMode(request.params.sessionId, payload.mode);
    if (!updated) throw new HttpError(404, "not_found", "会话不存在");
    return validateResponse(
      SessionPermissionResponseSchema,
      ok({ mode: payload.mode }, "会话权限已更新"),
    );
  });

  app.delete<{ Params: SessionParams }>("/sessions/:sessionId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const session = await sessions.getSession(request.params.sessionId);
    if (!session) throw new HttpError(404, "not_found", "会话不存在");
    await assertSessionOwner(request, session);
    const deleted = await sessions.deleteSession(request.params.sessionId);
    if (!deleted) {
      throw new HttpError(404, "not_found", "会话不存在");
    }
    return ok(undefined, "会话删除成功");
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/messages", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const session = await sessions.getSession(request.params.sessionId);
    if (!session) throw new HttpError(404, "not_found", "会话不存在");
    await assertSessionOwner(request, session);
    const query = request.query as { limit?: string; offset?: string };
    const limit = clampInt(query.limit, 20, 1, 1000);
    const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const messages = await sessions.listMessages({
      sessionId: request.params.sessionId,
      limit,
      offset,
    });
    if (!messages) throw new HttpError(404, "not_found", "会话不存在");
    return validateResponse(SessionMessageListResponseSchema, ok(messages, "获取对话记录成功"));
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/export", async (request, reply) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, request.params.sessionId, sessions);
    try {
      const data = await sessions.exportSession(request.params.sessionId);
      const safeSessionId = sanitizeExportSessionId(request.params.sessionId);
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="session_${safeSessionId}.json"`);
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(404, "not_found", message);
    }
  });

  app.get<{ Params: MessageParams }>(
    "/sessions/:sessionId/messages/:messageId/run-steps",
    async (request) => {
      const sessions = await resolveSessionApplication(options, request);
      await loadOwnedSession(request, request.params.sessionId, sessions);
      try {
        const query = request.query as { limit?: string; offset?: string };
        const input = {
          sessionId: request.params.sessionId,
          messageId: request.params.messageId,
          limit: clampInt(query.limit, 500, 1, 2000),
          offset: clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
        };
        const data = await sessions.listMessageRunSteps(input);
        return validateResponse(SessionMessageRunStepsResponseSchema, ok(data, "获取执行步骤成功"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("仅 assistant")) {
          throw new HttpError(400, "invalid_request", message);
        }
        throw new HttpError(404, "not_found", message);
      }
    },
  );

  app.patch<{ Params: MessageParams }>("/sessions/:sessionId/messages/:messageId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, request.params.sessionId, sessions);
    const payload = UpdateMessageRequestSchema.parse(request.body);
    const input = {
      sessionId: request.params.sessionId,
      messageId: request.params.messageId,
      content: payload.content,
    };
    const updated = await sessions.updateUserMessage(input);
    if (!updated) {
      throw new HttpError(404, "not_found", "消息不存在或不可编辑");
    }
    return ok({ message_id: request.params.messageId }, "更新成功");
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/rollback", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, request.params.sessionId, sessions);
    const payload = RollbackRequestSchema.parse(request.body);
    if (payload.after_seq == null && !payload.after_message_id) {
      throw new HttpError(400, "invalid_request", "请提供 after_seq 或 after_message_id");
    }
    const rollbackInput: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null } = {
      sessionId: request.params.sessionId,
    };
    if (payload.after_seq !== undefined) {
      rollbackInput.afterSeq = payload.after_seq;
    }
    if (payload.after_message_id !== undefined) {
      rollbackInput.afterMessageId = payload.after_message_id;
    }
    const deleted = await sessions.rollbackMessages(rollbackInput);
    return ok({ deleted }, "回退成功");
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/rollback-and-retry", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadOwnedSession(request, request.params.sessionId, sessions);
    const payload = parseRollbackAndRetryRequest(request.body);
    if (payload.after_seq == null && !payload.after_message_id) {
      throw new HttpError(400, "invalid_request", "请提供 after_seq 或 after_message_id");
    }
    try {
      const retryInput: {
        sessionId: string;
        userId: typeof request.identity.userId;
        requestId: string;
        afterSeq?: number | null;
        afterMessageId?: string | null;
        modifyUserMessage?: string | null;
        selectedLlm?: string | null;
        attachments?: AttachmentRef[] | null;
        uiContext?: Record<string, unknown> | null;
      } = {
        sessionId: request.params.sessionId,
        userId: request.identity.userId,
        requestId: request.headers["x-request-id"]?.toString() ?? randomUUID(),
        selectedLlm: payload.selected_llm ?? payload.selectedLLM ?? null,
      };
      if (payload.after_seq !== undefined) {
        retryInput.afterSeq = payload.after_seq;
      }
      if (payload.after_message_id !== undefined) {
        retryInput.afterMessageId = payload.after_message_id;
      }
      if (payload.modify_user_message !== undefined) {
        retryInput.modifyUserMessage = payload.modify_user_message;
      }
      if (payload.attachments && payload.attachments.length) {
        retryInput.attachments = payload.attachments;
      }
      if (payload.ui_context) {
        retryInput.uiContext = payload.ui_context;
      }
      const result = await (await ensureRequestApplications(request, options)).execution.startRollbackRetry(retryInput);
      if (!result.started) {
        throw new HttpError(400, "invalid_request", result.error ?? "重试启动失败");
      }
      return ok(
        {
          ...result,
          answer: null,
          success: true,
          error: null,
          status: "started",
        },
        "重试已启动",
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("未找到会话")) {
        throw new HttpError(404, "not_found", message);
      }
      throw new HttpError(400, "invalid_request", message);
    }
  });

};

function clampInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = rawValue === undefined ? fallback : Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeExportSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "session";
}

function parseRollbackAndRetryRequest(body: unknown) {
  try {
    const parsed = RollbackAndRetryRequestSchema.parse(body);
    if (parsed.after_seq == null && !parsed.after_message_id) {
      throw new HttpError(422, "validation_error", "请求参数验证失败", ["body -> after_seq: Field required"]);
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    if (error instanceof ZodError) {
      throw new HttpError(
        422,
        "validation_error",
        "请求参数验证失败",
        error.issues.map((issue) => `body -> ${issue.path.join(" -> ") || "body"}: ${issue.message}`),
      );
    }
    throw error;
  }
}
