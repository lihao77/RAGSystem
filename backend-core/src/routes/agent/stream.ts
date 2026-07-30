import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import {
  ApprovalRequestSchema,
  InteractionRequestSchema,
  StreamExecuteRequestSchema,
  StreamStopRequestSchema,
  UserInputRequestSchema,
} from "../../contracts/execution/execution.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { assertExecutableSessionIfExists, loadExecutableSession } from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";
import { ensureRequestApplications } from "../../app/request-applications.js";

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
    const sessions = await resolveSessionApplication(options, request);
    await assertExecutableSessionIfExists(request, payload.session_id, sessions);
    const requestId = request.headers["x-request-id"]?.toString() ?? randomUUID();
    const result = await (await ensureRequestApplications(request, options)).execution.startStream(
      { ...payload, userId: request.identity.userId },
      requestId,
    );
    if (result.error && !result.started) {
      throw new HttpError(400, "invalid_request", result.error);
    }
    return ok(result);
  });

  app.post("/stream/stop", async (request) => {
    const payload = StreamStopRequestSchema.parse(request.body);
    await loadExecutableSession(request, payload.session_id, await resolveSessionApplication(options, request));
    const interrupted = await (await ensureRequestApplications(request, options)).execution.stopSession(payload.session_id);
    if (!interrupted) {
      throw new HttpError(404, "not_found", "该会话没有正在执行的任务");
    }
    return ok({ interrupted: true });
  });

  app.post<{ Params: ApprovalParams }>(
    "/sessions/:sessionId/approvals/:approvalId/respond",
    async (request) => {
      await loadExecutableSession(request, request.params.sessionId, await resolveSessionApplication(options, request));
      const payload = ApprovalRequestSchema.parse(request.body);
      const interactions = (await ensureRequestApplications(request, options)).interactions;
      const result = await interactions.respondApprovalAsync(
        request.params.sessionId,
        request.params.approvalId,
        { approved: payload.approved, message: payload.message ?? "" },
      );
      if (!result.resolved) {
        throw new HttpError(404, "not_found", "未找到对应的审批请求，可能已被取消或不存在");
      }
      return ok({
        resolved: true,
        ...(result.needsResume ? { resuming: true } : {}),
        interaction_id: request.params.approvalId,
        approval_id: request.params.approvalId,
        kind: "approval",
        approved: payload.approved,
        message: payload.message,
      });
    },
  );

  app.post<{ Params: InputParams }>("/sessions/:sessionId/inputs/:inputId/respond", async (request) => {
    await loadExecutableSession(request, request.params.sessionId, await resolveSessionApplication(options, request));
    const payload = UserInputRequestSchema.parse(request.body);
    const interactions = (await ensureRequestApplications(request, options)).interactions;
    const result = await interactions.respondUserInputAsync(
      request.params.sessionId,
      request.params.inputId,
      { value: payload.value ?? "" },
    );
    if (!result.resolved) {
      throw new HttpError(404, "not_found", "未找到对应的输入请求，可能已被取消或不存在");
    }
    return ok({ resolved: true, ...(result.needsResume ? { resuming: true } : {}) });
  });

  app.post<{ Params: InteractionParams }>(
    "/sessions/:sessionId/interactions/:interactionId/respond",
    async (request) => {
      await loadExecutableSession(request, request.params.sessionId, await resolveSessionApplication(options, request));
      const payload = InteractionRequestSchema.parse(request.body);
      const interactions = (await ensureRequestApplications(request, options)).interactions;
      const recovered = payload.kind === "approval"
          ? await interactions.respondApprovalAsync(request.params.sessionId, request.params.interactionId, {
              approved: payload.approved ?? false,
              message: payload.message ?? "",
            })
          : await interactions.respondUserInputAsync(request.params.sessionId, request.params.interactionId, {
              value: payload.value ?? "",
            });
      const result = {
        ...recovered,
        ...(payload.kind === "approval"
          ? { approved: payload.approved ?? false, message: payload.message ?? "" }
          : {}),
      };
      if (!result.resolved) {
        throw new HttpError(404, "not_found", "未找到对应的交互请求，可能已被取消或不存在");
      }
      return ok({
        resolved: true,
        ...(result.needsResume ? { resuming: true } : {}),
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

  app.post<{ Params: InteractionParams }>(
    "/sessions/:sessionId/interactions/:interactionId/resume",
    async (request) => {
      await loadExecutableSession(request, request.params.sessionId, await resolveSessionApplication(options, request));
      const disposition = await (await ensureRequestApplications(request, options)).interactions.resumeAsync(
        request.params.sessionId,
        request.params.interactionId,
      );
      if (disposition === "none") {
        throw new HttpError(409, "resume_unavailable", "该会话当前无法恢复执行");
      }
      return ok({ resumed: true, disposition });
    },
  );
};
