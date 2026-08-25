import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import "@ragsystem/backend-core/fastify-context.js";

import { SchedulerTaskCreateSchema, SchedulerTaskUpdateSchema } from "../contracts/task.js";
import { isValidCronExpression } from "../services/cron-parser.js";
import { SchedulerServiceError, type SchedulerService } from "../services/scheduler-service.js";
import { HttpError, httpErrorFrom } from "@ragsystem/backend-core/utils/errors.js";
import { requireTenantMember } from "@ragsystem/backend-core/routes/tenant-role.js";

interface TaskParams { taskId: string; }
interface LimitQuery { limit?: string | number; }

const CronExpression = z.string().trim().min(1).refine(isValidCronExpression, { message: "cron 表达式无效（需为合法 5 段表达式且一年内存在触发点）" });

export interface SchedulerRouteOptions {
  readonly scheduler: SchedulerService;
}

export const registerSchedulerRoutes: FastifyPluginAsync<SchedulerRouteOptions> = async (app, options) => {
  app.addHook("preHandler", async (request) => { requireTenantMember(request); });

  app.get("/tasks", async (request) => ({ tasks: await options.scheduler.listTasks(request.identity.tenantId) }));

  app.post("/tasks", async (request) => {
    try {
      const input = SchedulerTaskCreateSchema.extend({ cron: CronExpression }).parse(request.body);
      return await options.scheduler.createTask(request.identity.tenantId, request.identity.userId, input);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: TaskParams }>("/tasks/:taskId", async (request) => {
    const task = await options.scheduler.listTasks(request.identity.tenantId)
      .then((tasks) => tasks.find((item) => item.task_id === request.params.taskId));
    if (!task) throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    return task;
  });

  app.put<{ Params: TaskParams }>("/tasks/:taskId", async (request) => {
    try {
      const patch = SchedulerTaskUpdateSchema.extend({ cron: CronExpression.optional() }).parse(request.body);
      const updated = await options.scheduler.updateTask(request.identity.tenantId, request.params.taskId, patch);
      if (!updated) throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
      return updated;
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.delete<{ Params: TaskParams }>("/tasks/:taskId", async (request) => {
    if (!await options.scheduler.deleteTask(request.identity.tenantId, request.params.taskId)) {
      throw new HttpError(404, "not_found", `任务不存在: ${request.params.taskId}`);
    }
    return { status: "ok" };
  });

  app.post<{ Params: TaskParams }>("/tasks/:taskId/trigger", async (request) => {
    try {
      return await options.scheduler.triggerTask(request.identity.tenantId, request.params.taskId);
    } catch (error) {
      throw toHttpError(error);
    }
  });

  app.get<{ Params: TaskParams; Querystring: LimitQuery }>("/tasks/:taskId/history", async (request) => {
    const limit = Number(request.query.limit ?? 20);
    return {
      task_id: request.params.taskId,
      history: options.scheduler.getTaskHistory(request.identity.tenantId, request.params.taskId, Number.isFinite(limit) ? limit : 20),
    };
  });
};

function toHttpError(error: unknown): unknown {
  if (error instanceof SchedulerServiceError) {
    return new HttpError(error.statusCode, "invalid_request", error.message);
  }
  return httpErrorFrom(error);
}
