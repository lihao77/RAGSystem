import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import { randomUUID } from "node:crypto";

import { ok } from "../../contracts/common.js";
import { CollaborateRequestSchema, ExecuteRequestSchema } from "../../contracts/execution.js";
import { HttpError } from "../../utils/errors.js";
import type { RouteOptions } from "../route-options.js";
import { ZodError } from "zod";
import { isRecord } from "../../utils/guards.js";

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
  const executeSynchronously = async (container: FastifyRequest["container"], payload: ReturnType<typeof ExecuteRequestSchema.parse>, requestId: string) => {
    const result = await container.agentExecution.executeSynchronously(payload, requestId);
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
    return executeSynchronously(
      request.container,
      payload,
      request.headers["x-request-id"]?.toString() ?? randomUUID(),
    );
  });

  app.post<{ Params: ExecuteAgentParams }>("/execute/:agentName", async (request) => {
    const payload = ExecuteRequestSchema.parse({
      ...(isRecord(request.body) ? request.body : {}),
      agent: request.params.agentName,
    });
    return executeSynchronously(
      request.container,
      payload,
      request.headers["x-request-id"]?.toString() ?? randomUUID(),
    );
  });

  app.post("/collaborate", async (request) => {
    const payload = parseCollaborateRequest(request.body);
    if (payload.mode !== "sequential") {
      throw new HttpError(400, "invalid_request", "并行模式尚未实现");
    }
    const result = await request.container.agentExecution.collaborateSequentially(
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
    ok(request.container.agentExecution.getSessionTaskStatus(request.params.sessionId)),
  );

  app.get<{ Params: SessionExecutionParams }>("/sessions/:sessionId/execution-diagnostics", async (request) =>
    ok(request.container.agentExecution.getSessionExecutionDiagnostics(request.params.sessionId)),
  );

  app.get<{ Params: TaskExecutionParams }>("/tasks/:taskId/status", async (request) =>
    ok(request.container.agentExecution.getTaskStatus(request.params.taskId)),
  );

  app.get<{ Params: TaskExecutionParams }>("/tasks/:taskId/execution-diagnostics", async (request) =>
    ok(request.container.agentExecution.getTaskExecutionDiagnostics(request.params.taskId)),
  );

  app.get("/tasks/running", async (request) => ok(request.container.agentExecution.listRunningTasks()));

  app.get("/execution/overview", async (request) => {
    const query = request.query as { active_only?: string };
    const activeOnly = parseActiveOnly(query.active_only);
    const overview = request.container.agentExecution.getOverview(activeOnly);
    const data = overview.count > 0 ? overview : request.container.conversationStore.getPersistedExecutionOverview(activeOnly);
    return ok(normalizeExecutionOverview(data));
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
