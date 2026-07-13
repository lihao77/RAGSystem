import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import {
  ApprovalRequestSchema,
  InteractionRequestSchema,
  StreamExecuteRequestSchema,
  StreamStopRequestSchema,
  UserInputRequestSchema,
} from "../../contracts/execution.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";

interface ApprovalParams {
  sessionId: string;
  approvalId: string;
}

interface InputParams {
  sessionId: string;
  inputId: string;
}

interface InteractionParams {
  sessionId: string;
  interactionId: string;
}

export const registerStreamRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.post("/stream", async (request) => {
    const payload = StreamExecuteRequestSchema.parse(request.body);
    const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
    const result = await request.container.agentExecution.startStream(payload, requestId);
    if (result.error && !result.started) {
      throw new HttpError(400, "invalid_request", result.error);
    }
    return ok(result);
  });

  app.post("/stream/stop", async (request) => {
    const payload = StreamStopRequestSchema.parse(request.body);
    const interrupted = await request.container.agentExecution.stopSession(payload.session_id);
    if (!interrupted) {
      throw new HttpError(404, "not_found", "该会话没有正在执行的任务");
    }
    return ok({ interrupted: true });
  });

  app.post<{ Params: ApprovalParams }>(
    "/sessions/:sessionId/approvals/:approvalId/respond",
    async (request) => {
      const payload = ApprovalRequestSchema.parse(request.body);
      const resolved = request.container.pendingInteractions.respondApproval(
        request.params.sessionId,
        request.params.approvalId,
        payload,
      );
      if (!resolved) {
        throw new HttpError(404, "not_found", "未找到对应的审批请求，可能已被取消或不存在");
      }
      return ok({
        resolved: true,
        interaction_id: request.params.approvalId,
        approval_id: request.params.approvalId,
        kind: "approval",
        approved: payload.approved,
        message: payload.message,
      });
    },
  );

  app.post<{ Params: InputParams }>("/sessions/:sessionId/inputs/:inputId/respond", async (request) => {
    const payload = UserInputRequestSchema.parse(request.body);
    const resolved = request.container.pendingInteractions.respondUserInput(
      request.params.sessionId,
      request.params.inputId,
      payload,
    );
    if (!resolved) {
      throw new HttpError(404, "not_found", "未找到对应的输入请求，可能已被取消或不存在");
    }
    return ok({ resolved: true });
  });

  app.post<{ Params: InteractionParams }>(
    "/sessions/:sessionId/interactions/:interactionId/respond",
    async (request) => {
      const payload = InteractionRequestSchema.parse(request.body);
      const result = request.container.pendingInteractions.respondInteraction(
        request.params.sessionId,
        request.params.interactionId,
        payload,
      );
      if (!result.resolved) {
        throw new HttpError(404, "not_found", result.error ?? "未找到对应的交互请求，可能已被取消或不存在");
      }
      return ok({
        resolved: true,
        interaction_id: request.params.interactionId,
        kind: result.kind,
        ...(result.kind === "approval"
          ? {
              approval_id: request.params.interactionId,
              approved: result.approved ?? false,
              message: result.message ?? "",
            }
          : {}),
      });
    },
  );
};
