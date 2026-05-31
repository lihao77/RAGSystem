import type { FastifyPluginAsync } from "fastify";

import {
  CronTaskSchema,
  CronTaskUpdateSchema,
  DaemonConfigUpdateSchema,
  DaemonOutgoingMessageSchema,
  DaemonTestMessageSchema,
} from "../contracts/daemon.js";
import { DaemonServiceError } from "../services/daemon-service.js";
import { HttpError, NotMigratedError } from "../utils/errors.js";
import type { RouteOptions } from "./route-options.js";

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
  app.get("/status", async () => options.container.daemon.getStatus());

  app.get("/config", async () => options.container.daemon.getConfig());

  app.put("/config", async (request) => {
    const payload = DaemonConfigUpdateSchema.parse(request.body);
    return options.container.daemon.updateConfig(payload);
  });

  app.post("/start", async () => {
    throw new NotMigratedError("Daemon runtime start");
  });

  app.post("/stop", async () => {
    throw new NotMigratedError("Daemon runtime stop");
  });

  app.get("/agents", async () => options.container.daemon.listAgents());

  app.get<{ Params: AgentParams }>("/agents/:teamName/status", async (request) => {
    const status = options.container.daemon.getAgentStatus(request.params.teamName);
    if (!status) {
      throw new HttpError(404, "not_found", `守护机器人不存在: ${request.params.teamName}`);
    }
    return status;
  });

  app.get<{ Params: AgentParams; Querystring: HeartbeatQuery }>("/agents/:teamName/heartbeat", async (request) => {
    const limit = Number(request.query.limit ?? 20);
    const heartbeat = options.container.daemon.getAgentHeartbeat(
      request.params.teamName,
      Number.isFinite(limit) ? limit : 20,
    );
    if (!heartbeat) {
      throw new HttpError(404, "not_found", `守护机器人不存在: ${request.params.teamName}`);
    }
    return heartbeat;
  });

  app.post<{ Params: AgentParams }>("/agents/:teamName/test", async (request) => {
    DaemonTestMessageSchema.parse(request.body);
    if (!options.container.daemon.getAgentStatus(request.params.teamName)) {
      throw new HttpError(404, "not_found", `守护机器人不存在: ${request.params.teamName}`);
    }
    throw new NotMigratedError("Daemon test message dispatch");
  });

  app.post("/send", async (request) => {
    DaemonOutgoingMessageSchema.parse(request.body);
    throw new NotMigratedError("Daemon outbound message dispatch");
  });

  app.get("/cron/tasks", async () => options.container.daemon.listCronTasks());

  app.post("/cron/tasks", async (request) => {
    const payload = CronTaskSchema.parse(request.body);
    try {
      return {
        status: "ok",
        task_id: options.container.daemon.createCronTask(payload),
      };
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.put<{ Params: CronTaskParams }>("/cron/tasks/:taskId", async (request) => {
    const payload = CronTaskUpdateSchema.parse(request.body);
    const updated = options.container.daemon.updateCronTask(request.params.taskId, payload);
    if (!updated) {
      throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    }
    return {
      status: "ok",
      task_id: request.params.taskId,
    };
  });

  app.delete<{ Params: CronTaskParams }>("/cron/tasks/:taskId", async (request) => {
    const deleted = options.container.daemon.deleteCronTask(request.params.taskId);
    if (!deleted) {
      throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    }
    return { status: "ok" };
  });

  app.post<{ Params: CronTaskParams }>("/cron/tasks/:taskId/trigger", async (request) => {
    const exists = options.container.daemon.listCronTasks().some((task) => task.task_id === request.params.taskId);
    if (!exists) {
      throw new HttpError(404, "not_found", `任务不存在或执行失败: ${request.params.taskId}`);
    }
    throw new NotMigratedError("Daemon cron task execution");
  });

  app.get<{ Params: CronTaskParams; Querystring: HeartbeatQuery }>("/cron/tasks/:taskId/history", async (request) => {
    const limit = Number(request.query.limit ?? 20);
    return {
      task_id: request.params.taskId,
      history: options.container.daemon.getCronHistory(request.params.taskId, Number.isFinite(limit) ? limit : 20),
    };
  });
};

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) {
    return error;
  }
  if (error instanceof DaemonServiceError) {
    return new HttpError(error.statusCode, "invalid_request", error.message);
  }
  return new HttpError(500, "internal_error", error instanceof Error ? error.message : String(error));
}
