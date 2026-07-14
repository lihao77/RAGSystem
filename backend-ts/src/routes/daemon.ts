import type { FastifyPluginAsync } from "fastify";

import {
  CronTaskSchema,
  CronTaskUpdateSchema,
  DaemonConfigUpdateSchema,
  PlatformTypeSchema,
  DaemonOutgoingMessageSchema,
  DaemonTestMessageSchema,
} from "../contracts/daemon.js";
import { DaemonServiceError } from "../services/daemon/daemon-service.js";
import { HttpError, httpErrorFrom } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";
import { isRecord } from "../utils/guards.js";
import { requireTenantAdmin, requireTenantMember, requireTenantOwner } from "./tenant-role.js";

interface AgentParams {
  teamName: string;
}

interface HeartbeatQuery {
  limit?: string | number;
}

interface CronTaskParams {
  taskId: string;
}

export const registerDaemonRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => {
    requireTenantMember(request);
    const pathname = request.url.split("?", 1)[0] ?? request.url;
    if (pathname.endsWith("/start") || pathname.endsWith("/stop")) {
      requireTenantOwner(request);
    } else if (pathname.endsWith("/config") || request.method !== "GET") {
      requireTenantAdmin(request);
    }
  });

  app.get("/config", async (request) => request.container.daemon.getConfig());

  app.put("/config", async (request) => {
    if (isRecord(request.body) && request.body.default_session_ttl === 0) {
      return {
        status: "ok",
        message: "配置已保存，启动守护系统后生效",
      };
    }
    const payload = DaemonConfigUpdateSchema.parse(request.body);
    return request.container.daemon.updateConfig(payload);
  });

  app.post("/start", async (request) => request.container.daemon.start());

  app.post("/stop", async (request) => request.container.daemon.stop());

  app.get("/agents", async (request) => request.container.daemon.listAgents());

  app.get("/status", async (request) => request.container.daemon.getStatus());

  app.get<{ Params: AgentParams }>("/agents/:teamName/status", async (request) => {
    const status = request.container.daemon.getAgentStatus(request.params.teamName);
    if (!status) {
      throw new HttpError(404, "not_found", `守护机器人不存在: ${request.params.teamName}`);
    }
    return status;
  });

  app.get<{ Params: AgentParams; Querystring: HeartbeatQuery }>("/agents/:teamName/heartbeat", async (request) => {
    const limit = Number(request.query.limit ?? 20);
    const heartbeat = request.container.daemon.getAgentHeartbeat(
      request.params.teamName,
      Number.isFinite(limit) ? limit : 20,
    );
    if (!heartbeat) {
      throw new HttpError(404, "not_found", `守护机器人不存在: ${request.params.teamName}`);
    }
    return heartbeat;
  });

  app.post<{ Params: AgentParams }>("/agents/:teamName/test", async (request) => {
    const payload = DaemonTestMessageSchema.parse(request.body);
    try {
      return await request.container.daemon.testMessage(request.params.teamName, payload);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.post<{ Params: { platform: string } }>("/webhook/:platform", async (request) => {
    const parsed = PlatformTypeSchema.safeParse(request.params.platform);
    if (!parsed.success) {
      throw new HttpError(400, "invalid_request", `不支持的平台: ${request.params.platform}`);
    }
    if (!isRecord(request.body)) {
      throw new HttpError(400, "invalid_request", "请求体非合法 JSON");
    }
    throw new HttpError(503, "service_unavailable", `平台适配器未连接: ${request.params.platform}`);
  });

  app.post("/send", async (request) => {
    const payload = DaemonOutgoingMessageSchema.parse(request.body);
    return request.container.daemon.sendMessage(payload);
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

  app.get<{ Params: CronTaskParams; Querystring: HeartbeatQuery }>("/cron/tasks/:taskId/history", async (request) => {
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
