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
import { assertOwnedSessionIfExists, loadOwnedSession } from "../session-owner.js";
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
    await assertOwnedSessionIfExists(request, payload.session_id, sessions);
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
    await loadOwnedSession(request, payload.session_id, await resolveSessionApplication(options, request));
    const interrupted = await (await ensureRequestApplications(request, options)).execution.stopSession(payload.session_id);
    if (!interrupted) {
      throw new HttpError(404, "not_found", "该会话没有正在执行的任务");
    }
    return ok({ interrupted: true });
  });

  app.post<{ Params: ApprovalParams }>(
    "/sessions/:sessionId/approvals/:approvalId/respond",
    async (request) => {
      await loadOwnedSession(request, request.params.sessionId, await resolveSessionApplication(options, request));
      const payload = ApprovalRequestSchema.parse(request.body);
      const interactions = (await ensureRequestApplications(request, options)).interactions;
      const result = await interactions.respondApproval(
        request.params.sessionId,
        request.params.approvalId,
        { approved: payload.approved, message: payload.message ?? "" },
      );
      if (!result.resolved) {
        throw new HttpError(404, "not_found", "未找到对应的审批请求，可能已被取消或不存在");
      }
      if (result.needsResume) {
        (await ensureRequestApplications(request, options)).execution.resumeRun({
          sessionId: request.params.sessionId,
          approvalId: request.params.approvalId,
          resolution: { approved: payload.approved, message: payload.message ?? "" },
        });
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
    await loadOwnedSession(request, request.params.sessionId, await resolveSessionApplication(options, request));
    const payload = UserInputRequestSchema.parse(request.body);
    const interactions = (await ensureRequestApplications(request, options)).interactions;
    const result = await interactions.respondUserInput(
      request.params.sessionId,
      request.params.inputId,
      { value: payload.value ?? "" },
    );
    if (!result.resolved) {
      throw new HttpError(404, "not_found", "未找到对应的输入请求，可能已被取消或不存在");
    }
    if (result.needsResume) {
      (await ensureRequestApplications(request, options)).execution.resumeRun({
        sessionId: request.params.sessionId,
        approvalId: request.params.inputId,
        resolution: { value: payload.value ?? "" },
      });
    }
    return ok({ resolved: true, ...(result.needsResume ? { resuming: true } : {}) });
  });

  app.post<{ Params: InteractionParams }>(
    "/sessions/:sessionId/interactions/:interactionId/respond",
    async (request) => {
      await loadOwnedSession(request, request.params.sessionId, await resolveSessionApplication(options, request));
      const payload = InteractionRequestSchema.parse(request.body);
      const interactions = (await ensureRequestApplications(request, options)).interactions;
      const recovered = payload.kind === "approval"
          ? await interactions.respondApproval(request.params.sessionId, request.params.interactionId, {
              approved: payload.approved ?? false,
              message: payload.message ?? "",
            })
          : await interactions.respondUserInput(request.params.sessionId, request.params.interactionId, {
              value: payload.value ?? "",
            });
      const result = {
        ...recovered,
        ...(payload.kind === "approval"
          ? { approved: payload.approved ?? false, message: payload.message ?? "" }
          : {}),
      };
      if (!result.resolved) {
        throw new HttpError(404, "not_found", result.error ?? "未找到对应的交互请求，可能已被取消或不存在");
      }
      if (result.needsResume) {
        (await ensureRequestApplications(request, options)).execution.resumeRun({
          sessionId: request.params.sessionId,
          approvalId: request.params.interactionId,
          resolution: result.kind === "approval"
            ? { approved: result.approved ?? false, message: result.message ?? "" }
            : { value: payload.value ?? "" },
        });
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
};
