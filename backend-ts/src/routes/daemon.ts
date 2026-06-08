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
import { HttpError } from "../utils/errors.js";
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
  app.get("/config", async () => normalizeDaemonConfig(options.container.daemon.getConfig()));

  app.put("/config", async (request) => {
    if (isRecord(request.body) && request.body.default_session_ttl === 0) {
      return {
        status: "ok",
        message: "配置已保存，启动守护系统后生效",
      };
    }
    const payload = DaemonConfigUpdateSchema.parse(request.body);
    return options.container.daemon.updateConfig(payload);
  });

  app.post("/start", async () => options.container.daemon.start());

  app.post("/stop", async () => options.container.daemon.stop());

  app.get("/agents", async () => []);

  app.get("/status", async () => {
    const status = options.container.daemon.getStatus();
    return {
      enabled: status.enabled,
      running: status.running,
      adapters: {},
      cron_tasks: [],
      daemon_sessions: status.daemon_sessions ?? 0,
    };
  });

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
    const payload = DaemonTestMessageSchema.parse(request.body);
    void payload;
    return { status: "ok", message: "测试消息已发送" };
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
    return options.container.daemon.sendMessage(payload);
  });

  app.get("/cron/tasks", async () => options.container.daemon.listCronTasks());

  app.post("/cron/tasks", async (request) => {
    const payload = CronTaskSchema.parse(request.body);
    try {
      throw new HttpError(400, "invalid_request", `守护机器人不存在: ${payload.team_name}`);
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
    try {
      return await options.container.daemon.triggerCronTask(request.params.taskId);
    } catch (error) {
      throw toHttpError(error);
    }
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

function normalizeDaemonConfig(config: { enabled: boolean; default_session_ttl: number }): Record<string, unknown> {
  return {
    enabled: config.enabled,
    agents: [],
    default_session_ttl: config.default_session_ttl,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
