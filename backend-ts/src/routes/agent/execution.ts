import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";

import { ok } from "../../contracts/common.js";
import { CollaborateRequestSchema, ExecuteRequestSchema } from "../../contracts/execution.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";

interface ExecuteAgentParams {
  agentName: string;
}

interface SessionExecutionParams {
  sessionId: string;
}

interface TaskExecutionParams {
  taskId: string;
}

export const registerExecutionRoutes: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.post("/execute", async (request) => {
    const payload = ExecuteRequestSchema.parse(request.body);
    const result = await options.container.agentExecution.executeSynchronously(
      payload,
      request.headers["x-request-id"]?.toString() ?? randomUUID(),
    );
    if (!result.success) {
      throw new HttpError(500, "execution_failed", result.error ?? "任务执行失败");
    }
    return ok(
      {
        answer: result.answer,
        agent_name: result.agent_name,
        execution_time: result.execution_time,
        tool_calls: result.tool_calls,
        metadata: result.metadata,
        session_id: result.session_id,
      },
      "任务执行成功",
    );
  });

  app.post<{ Params: ExecuteAgentParams }>("/execute/:agentName", async (request) => {
    const payload = ExecuteRequestSchema.parse({
      ...(isRecord(request.body) ? request.body : {}),
      agent: request.params.agentName,
    });
    const result = await options.container.agentExecution.executeSynchronously(
      payload,
      request.headers["x-request-id"]?.toString() ?? randomUUID(),
    );
    if (!result.success) {
      throw new HttpError(500, "execution_failed", result.error ?? "任务执行失败");
    }
    return ok(
      {
        answer: result.answer,
        agent_name: result.agent_name,
        execution_time: result.execution_time,
        tool_calls: result.tool_calls,
        metadata: result.metadata,
        session_id: result.session_id,
      },
      "任务执行成功",
    );
  });

  app.post("/collaborate", async (request) => {
    const payload = CollaborateRequestSchema.parse(request.body);
    if (payload.mode !== "sequential") {
      throw new HttpError(400, "invalid_request", "并行模式尚未实现");
    }
    const result = await options.container.agentExecution.collaborateSequentially(
      payload,
      request.headers["x-request-id"]?.toString() ?? randomUUID(),
    );
    return ok(
      {
        results: result.results.map((item) => ({
          success: item.success,
          content: item.answer,
          error: item.error,
          agent_name: item.agent_name,
          execution_time: item.execution_time,
        })),
        session_id: result.session_id,
        total_tasks: result.total_tasks,
      },
      "协作任务执行完成",
    );
  });

  app.get<{ Params: SessionExecutionParams }>("/sessions/:sessionId/task-status", async (request) =>
    ok(options.container.agentExecution.getSessionTaskStatus(request.params.sessionId)),
  );

  app.get<{ Params: SessionExecutionParams }>("/sessions/:sessionId/execution-diagnostics", async (request) =>
    ok(options.container.agentExecution.getSessionExecutionDiagnostics(request.params.sessionId)),
  );

  app.get<{ Params: TaskExecutionParams }>("/tasks/:taskId/status", async (request) =>
    ok(options.container.agentExecution.getTaskStatus(request.params.taskId)),
  );

  app.get<{ Params: TaskExecutionParams }>("/tasks/:taskId/execution-diagnostics", async (request) =>
    ok(options.container.agentExecution.getTaskExecutionDiagnostics(request.params.taskId)),
  );

  app.get("/tasks/running", async () => ok(options.container.agentExecution.listRunningTasks()));

  app.get("/execution/overview", async (request) => {
    const query = request.query as { active_only?: string };
    return ok(options.container.agentExecution.getOverview(parseActiveOnly(query.active_only)));
  });
};

function parseActiveOnly(rawValue: string | undefined): boolean {
  return !new Set(["0", "false", "no", "off"]).has(String(rawValue ?? "true").trim().toLowerCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
