import type { FastifyPluginAsync } from "fastify";
import { randomUUID } from "node:crypto";

import { ok } from "../../contracts/common.js";
import { CollaborateRequestSchema, ExecuteRequestSchema, type ExecuteRequest } from "../../contracts/execution/execution.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { ZodError } from "zod";
import { isRecord } from "../../utils/guards.js";
import { assertExecutableSessionIfExists, assertReadableSessionIfExists } from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";
import { ensureRequestApplications } from "../../app/request-applications.js";

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
  const executeSynchronously = async (execution: Awaited<ReturnType<typeof ensureRequestApplications>>["execution"], payload: ExecuteRequest, requestId: string) => {
    const result = await execution.executeSynchronously(payload, requestId);
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
  };

  app.post("/execute", async (request) => {
    const payload = ExecuteRequestSchema.parse(request.body);
    const sessions = await resolveSessionApplication(options, request);
    await assertExecutableSessionIfExists(request, payload.session_id, sessions);
    return executeSynchronously(
      (await ensureRequestApplications(request, options)).execution,
      { ...payload, userId: request.identity.userId },
      request.headers["x-request-id"]?.toString() ?? randomUUID(),
    );
  });

  app.post<{ Params: ExecuteAgentParams }>("/execute/:agentName", async (request) => {
    const payload = ExecuteRequestSchema.parse({
      ...(isRecord(request.body) ? request.body : {}),
      agent: request.params.agentName,
    });
    const sessions = await resolveSessionApplication(options, request);
    await assertExecutableSessionIfExists(request, payload.session_id, sessions);
    return executeSynchronously(
      (await ensureRequestApplications(request, options)).execution,
      { ...payload, userId: request.identity.userId },
      request.headers["x-request-id"]?.toString() ?? randomUUID(),
    );
  });

  app.post("/collaborate", async (request) => {
    const payload = parseCollaborateRequest(request.body);
    const sessions = await resolveSessionApplication(options, request);
    await assertExecutableSessionIfExists(request, payload.session_id, sessions);
    if (payload.mode !== "sequential") {
      throw new HttpError(400, "invalid_request", "并行模式尚未实现");
    }
    const result = await (await ensureRequestApplications(request, options)).execution.collaborateSequentially(
      { ...payload, userId: request.identity.userId },
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

  app.get<{ Params: SessionExecutionParams }>("/sessions/:sessionId/task-status", async (request) => {
    const sessionApp = await resolveSessionApplication(options, request);
    await assertReadableSessionIfExists(request, request.params.sessionId, sessionApp);
    const reader = (await ensureRequestApplications(request, options)).executionRead;
    return ok(await reader.getSessionTaskStatus(request.params.sessionId));
  });

  app.get<{ Params: SessionExecutionParams }>("/sessions/:sessionId/execution-diagnostics", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await assertReadableSessionIfExists(request, request.params.sessionId, sessions);
    const reader = (await ensureRequestApplications(request, options)).executionRead;
    return ok(await reader.getSessionExecutionDiagnostics(request.params.sessionId));
  });

  app.get<{ Params: TaskExecutionParams }>("/tasks/:taskId/status", async (request) => {
    const reader = (await ensureRequestApplications(request, options)).executionRead;
    return ok(await reader.getTaskStatus(request.params.taskId));
  });

  app.get<{ Params: TaskExecutionParams }>("/tasks/:taskId/execution-diagnostics", async (request) => {
    const reader = (await ensureRequestApplications(request, options)).executionRead;
    return ok(await reader.getTaskExecutionDiagnostics(request.params.taskId));
  });

  app.get("/tasks/running", async (request) => {
    const reader = (await ensureRequestApplications(request, options)).executionRead;
    return ok(await reader.listRunningTasks());
  });

  app.get("/execution/overview", async (request) => {
    const query = request.query as { active_only?: string };
    const activeOnly = parseActiveOnly(query.active_only);
    const reader = (await ensureRequestApplications(request, options)).executionRead;
    return ok(normalizeExecutionOverview(await reader.getOverview(activeOnly)));
  });
};

function normalizeExecutionOverview<T extends { by_execution_kind: Record<string, number>; by_status: Record<string, number> }>(overview: T): T {
  return {
    ...overview,
    by_execution_kind: {
      agent_stream: overview.by_execution_kind.agent_stream ?? 0,
      mcp_connect: overview.by_execution_kind.mcp_connect ?? 0,
      mcp_disconnect: overview.by_execution_kind.mcp_disconnect ?? 0,
      mcp_refresh: overview.by_execution_kind.mcp_refresh ?? 0,
      mcp_test: overview.by_execution_kind.mcp_test ?? 0,
    },
    by_status: {
      completed: overview.by_status.completed ?? 0,
      failed: overview.by_status.failed ?? 0,
      interrupted: overview.by_status.interrupted ?? 0,
    },
  };
}

function parseActiveOnly(rawValue: string | undefined): boolean {
  return !new Set(["0", "false", "no", "off"]).has(String(rawValue ?? "true").trim().toLowerCase());
}

function parseCollaborateRequest(body: unknown) {
  try {
    return CollaborateRequestSchema.parse(body);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(
        422,
        "validation_error",
        "请求参数验证失败",
        error.issues.map((issue) => `body -> ${issue.path.join(" -> ") || "body"}: ${issue.message}`),
      );
    }
    throw error;
  }
}
