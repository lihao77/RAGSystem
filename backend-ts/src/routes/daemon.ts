import type { FastifyPluginAsync } from "fastify";

import {
  CronTaskSchema,
  CronTaskUpdateSchema,
  DaemonConfigUpdateSchema,
  DaemonOutgoingMessageSchema,
  DaemonTestMessageSchema,
} from "../contracts/daemon.js";
import { DaemonServiceError } from "../services/daemon/daemon-service.js";
import { HttpError, httpErrorFrom } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { requireTenantAdmin, requireTenantMember } from "./tenant-role.js";

interface AgentParams {
  teamName: string;
}

interface LimitQuery {
  limit?: string | number;
}

interface CronTaskParams {
  taskId: string;
}

export const registerDaemonRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => {
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname.includes("/webhook/")) return;
    requireTenantMember(request);
    if (pathname.endsWith("/config") || request.method !== "GET") {
      requireTenantAdmin(request);
    }
  });

  app.get("/config", async (request) => request.container.daemon.getConfig());

  app.put("/config", async (request) => {
    const payload = DaemonConfigUpdateSchema.parse(request.body);
    return request.container.daemon.updateConfig(payload);
  });

  app.post<{ Params: AgentParams }>("/agents/:teamName/test", async (request) => {
    const payload = DaemonTestMessageSchema.parse(request.body);
    try {
      return await request.container.daemon.testMessage(request.params.teamName, payload);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: { platform: string; routeToken: string } }>("/webhook/:platform/:routeToken", async (request) => {
    if (request.params.platform !== "feishu") {
      throw new HttpError(400, "invalid_request", `不支持的平台: ${request.params.platform}`);
    }
    const target = options.registry.resolveRouteToken(request.params.routeToken);
    if (!target) throw new HttpError(404, "not_found", "无效的飞书 webhook routeToken");
    const lease = await options.registry.acquire(target.tenantId);
    try {
      return await lease.runtime.daemon.handleIncomingMessage(request.params.routeToken, request.body);
    } catch (error) {
      throw toHttpError(error);
    } finally {
      lease.release();
    }
  });

  app.post("/send", async (request) => {
    const payload = DaemonOutgoingMessageSchema.parse(request.body);
    return await request.container.daemon.sendMessage(payload);
  });

  app.get("/cron/tasks", async (request) => request.container.daemon.listCronTasks());

  app.post("/cron/tasks", async (request) => {
    const payload = CronTaskSchema.parse(request.body);
    try {
      return {
        status: "ok",
        task_id: request.container.daemon.createCronTask(payload),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: CronTaskParams }>("/cron/tasks/:taskId", async (request) => {
    const payload = CronTaskUpdateSchema.parse(request.body);
    const updated = request.container.daemon.updateCronTask(request.params.taskId, payload);
    if (!updated) {
      throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    }
    return {
      status: "ok",
      task_id: request.params.taskId,
    };
  });

  app.delete<{ Params: CronTaskParams }>("/cron/tasks/:taskId", async (request) => {
    const deleted = request.container.daemon.deleteCronTask(request.params.taskId);
    if (!deleted) {
      throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    }
    return { status: "ok" };
  });

  app.post<{ Params: CronTaskParams }>("/cron/tasks/:taskId/trigger", async (request) => {
    try {
      return await request.container.daemon.triggerCronTask(request.params.taskId);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: CronTaskParams; Querystring: LimitQuery }>("/cron/tasks/:taskId/history", async (request) => {
    const limit = Number(request.query.limit ?? 20);
    return {
      task_id: request.params.taskId,
      history: request.container.daemon.getCronHistory(request.params.taskId, Number.isFinite(limit) ? limit : 20),
    };
  });
};

function toHttpError(error: unknown): HttpError {
  return httpErrorFrom(error, (e) =>
    e instanceof DaemonServiceError ? new HttpError(e.statusCode, "invalid_request", e.message) : null,
  );
}
