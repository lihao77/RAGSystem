import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import {
  ApprovalRequestSchema,
  StreamExecuteRequestSchema,
  StreamStopRequestSchema,
  UserInputRequestSchema,
} from "../../contracts/execution.js";
import { HttpError, NotMigratedError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";

interface ApprovalParams {
  sessionId: string;
  approvalId: string;
}

interface InputParams {
  sessionId: string;
  inputId: string;
}

export const registerStreamRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.post("/stream", async (request) => {
    const payload = StreamExecuteRequestSchema.parse(request.body);
    const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
    try {
      const result = await options.container.agentExecution.startStream(payload, requestId);
      if (result.error && !result.started) {
        throw new HttpError(400, "invalid_request", result.error);
      }
      return ok(result);
    } catch (error) {
      if (error instanceof NotMigratedError) {
        throw error;
      }
      throw error;
    }
  });

  app.post("/stream/stop", async (request) => {
    const payload = StreamStopRequestSchema.parse(request.body);
    const interrupted = await options.container.agentExecution.stopSession(payload.session_id);
    if (!interrupted) {
      throw new HttpError(404, "not_found", "该会话没有正在执行的任务");
    }
    return ok({ interrupted: true });
  });

  app.post<{ Params: ApprovalParams }>(
    "/sessions/:sessionId/approvals/:approvalId/respond",
    async (request) => {
      ApprovalRequestSchema.parse(request.body);
      throw new NotMigratedError("Tool approval resolution");
    },
  );

  app.post<{ Params: InputParams }>("/sessions/:sessionId/inputs/:inputId/respond", async (request) => {
    const payload = UserInputRequestSchema.parse(request.body);
    const resolved = options.container.pendingInteractions.respondUserInput(
      request.params.sessionId,
      request.params.inputId,
      payload,
    );
    if (!resolved) {
      throw new HttpError(404, "not_found", "未找到对应的输入请求，可能已被取消或不存在");
    }
    return ok({ resolved: true });
  });
};
