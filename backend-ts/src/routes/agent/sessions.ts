import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import {
  CreateSessionRequestSchema,
  RollbackAndRetryRequestSchema,
  RollbackRequestSchema,
  UpdateMessageRequestSchema,
} from "../../contracts/session.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { ZodError } from "zod";

interface SessionParams {
  sessionId: string;
}

interface MessageParams extends SessionParams {
  messageId: string;
}

export const registerSessionRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.post("/sessions", async (request) => {
    const payload = CreateSessionRequestSchema.parse(request.body);
    const session = options.container.sessionApplication.createSession({
      sessionId: payload.session_id?.trim() || randomUUID(),
      userId: payload.user_id ?? null,
      metadata: payload.metadata,
    });
    return ok(session, "会话创建成功");
  });

  app.get("/sessions", async (request) => {
    const query = request.query as { limit?: string; offset?: string; user_id?: string };
    const limit = clampInt(query.limit, 20, 1, 200);
    const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const sessions = options.container.sessionApplication.listSessions({
      limit,
      offset,
      userId: normalizeEmpty(query.user_id),
    });
    return ok(sessions, "获取会话列表成功");
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId", async (request) => {
    const session = options.container.sessionApplication.getSession(request.params.sessionId);
    if (!session) {
      throw new HttpError(404, "not_found", "会话不存在");
    }
    return ok(session, "获取会话成功");
  });

  app.delete<{ Params: SessionParams }>("/sessions/:sessionId", async (request) => {
    const deleted = options.container.sessionApplication.deleteSession(request.params.sessionId);
    if (!deleted) {
      throw new HttpError(404, "not_found", "会话不存在");
    }
    return ok(undefined, "会话删除成功");
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/messages", async (request) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = clampInt(query.limit, 20, 1, 1000);
    const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const messages = options.container.sessionApplication.listMessages({
      sessionId: request.params.sessionId,
      limit,
      offset,
      expandSteps: parseExpandSteps((request.query as { expand?: string }).expand),
    });
    return ok(messages, "获取对话记录成功");
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/export", async (request, reply) => {
    try {
      const data = options.container.sessionApplication.exportSession(request.params.sessionId);
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
      try {
        const query = request.query as { limit?: string; offset?: string };
        const data = options.container.sessionApplication.listMessageRunSteps({
          sessionId: request.params.sessionId,
          messageId: request.params.messageId,
          limit: clampInt(query.limit, 500, 1, 2000),
          offset: clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
        });
        return ok(data, "获取执行步骤成功");
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
    const payload = UpdateMessageRequestSchema.parse(request.body);
    const updated = options.container.sessionApplication.updateUserMessage({
      sessionId: request.params.sessionId,
      messageId: request.params.messageId,
      content: payload.content,
    });
    if (!updated) {
      throw new HttpError(404, "not_found", "消息不存在或不可编辑");
    }
    return ok({ message_id: request.params.messageId }, "更新成功");
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/rollback", async (request) => {
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
    const deleted = options.container.sessionApplication.rollbackMessages(rollbackInput);
    return ok({ deleted }, "回退成功");
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/rollback-and-retry", async (request) => {
    const payload = parseRollbackAndRetryRequest(request.body);
    if (payload.after_seq == null && !payload.after_message_id) {
      throw new HttpError(400, "invalid_request", "请提供 after_seq 或 after_message_id");
    }
    try {
      const retryInput: {
        sessionId: string;
        userId?: string | null;
        requestId: string;
        afterSeq?: number | null;
        afterMessageId?: string | null;
        modifyUserMessage?: string | null;
        selectedLlm?: string | null;
      } = {
        sessionId: request.params.sessionId,
        userId: payload.user_id ?? null,
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
      const result = await options.container.agentExecution.startRollbackRetry(retryInput);
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

function normalizeEmpty(value: string | undefined): string | null {
  if (!value?.trim()) {
    return null;
  }
  return value.trim();
}

function parseExpandSteps(value: string | undefined): boolean {
  return ["1", "true", "steps", "yes"].includes(String(value ?? "none").toLowerCase());
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
