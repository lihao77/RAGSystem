import type { FastifyPluginAsync } from "fastify";

import { ok } from "../../contracts/common.js";
import { CollaborateRequestSchema, ExecuteRequestSchema } from "../../contracts/execution.js";
import { HttpError, NotMigratedError } from "../../utils/errors.js";
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
    ExecuteRequestSchema.parse(request.body);
    throw new NotMigratedError("Synchronous agent execution");
  });

  app.post<{ Params: ExecuteAgentParams }>("/execute/:agentName", async (request) => {
    ExecuteRequestSchema.parse({
      ...(isRecord(request.body) ? request.body : {}),
      agent: request.params.agentName,
    });
    throw new NotMigratedError("Synchronous specific-agent execution");
  });

  app.post("/collaborate", async (request) => {
    const payload = CollaborateRequestSchema.parse(request.body);
    if (payload.mode !== "sequential") {
      throw new HttpError(400, "invalid_request", "并行模式尚未实现");
    }
    throw new NotMigratedError("Multi-agent collaboration");
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
