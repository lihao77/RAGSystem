import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";
import {
  CreateSessionResponseSchema,
  SessionDetailResponseSchema,
  SessionListFacetsResponseSchema,
  SessionListResponseSchema,
  SessionMessageListResponseSchema,
  SessionMessageRunStepsResponseSchema,
  SessionParticipantListResponseSchema,
  SessionPermissionResponseSchema,
  SessionWsTicketResponseSchema,
  UpdateSessionPermissionModeRequestSchema,
  type SessionListFacets,
  type SessionListItem,
} from "@ragsystem/api-contracts";
import { WorkspaceListResponseSchema } from "@ragsystem/api-contracts";

import { ok, validateResponse } from "../../contracts/common.js";
import type { AttachmentRef } from "../../contracts/execution/execution.js";
import {
  CreateSessionRequestSchema,
  RollbackAndRetryRequestSchema,
  RollbackRequestSchema,
  UpdateMessageRequestSchema,
  SessionOriginTypeSchema,
} from "../../contracts/session/session.js";
import { CreateWorkspaceRequestSchema, WorkspaceResponseSchema } from "@ragsystem/api-contracts";
import { HttpError } from "../../utils/errors.js";
import { ensureRequestApplications } from "../../app/request-applications.js";
import type { AgentRouteOptions } from "../route-options.js";
import { z, ZodError } from "zod";
import {
  assertSessionMutable,
  assertSessionReadable,
  loadMutableSession,
  loadReadableSession,
  sessionListAccess,
} from "../session-owner.js";
import { resolveSessionApplication } from "../session-application.js";
import { decodeSessionListCursor, encodeSessionListCursor } from "../session-list-cursor.js";
import type { SessionApplication } from "../../contracts/session/session-application.js";
import type { SessionInfo, SessionListProjection } from "../../contracts/session/session.js";
import { TeamSelectionError } from "../../contracts/agent/agent-config.js";

interface SessionParams {
  sessionId: string;
}

interface MessageParams extends SessionParams {
  messageId: string;
}

interface WorkspaceParams {
  workspaceId: string;
}

interface BackgroundTaskParams extends SessionParams {
  taskId: string;
}

const BackgroundTaskIdSchema = z.string().uuid();
const CancelBackgroundTasksRequestSchema = z.object({
  task_ids: z.array(BackgroundTaskIdSchema).min(1).max(100),
}).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  value.task_ids.forEach((taskId, index) => {
    if (seen.has(taskId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["task_ids", index],
        message: "任务 ID 不能重复",
      });
    }
    seen.add(taskId);
  });
});

export const registerSessionRoutes: FastifyPluginAsync<AgentRouteOptions> = async (app, options) => {
  app.post("/sessions", async (request) => {
    const payload = CreateSessionRequestSchema.parse(request.body);
    try {
      const sessions = await resolveSessionApplication(options, request);
      const workspaceId = await sessions.resolveWorkspace(payload.workspace);
      const session = await sessions.createSession({
        sessionId: payload.session_id?.trim() || randomUUID(),
        ownerUserId: request.identity.userId,
        visibility: "private",
        originType: "direct",
        originId: null,
        originChannel: "web",
        workspaceId,
        teamName: payload.team_name ?? null,
        entryAgentName: payload.entry_agent_name ?? null,
        permissionMode: payload.permission_mode ?? null, ...(payload.metadata ? { metadata: payload.metadata } : {}),
      });
      return validateResponse(CreateSessionResponseSchema, ok(await assembleCreatedSession(session, sessions, options, request), "会话创建成功"));
    } catch (error) {
      if (error instanceof TeamSelectionError) {
        throw new HttpError(400, "invalid_request", error.message);
      }
      if (error instanceof Error && error.message.includes("Workspace")) {
        throw new HttpError(400, "invalid_request", error.message);
      }
      throw error;
    }
  });

  app.get("/sessions", async (request) => {
    const query = request.query as { limit?: string; cursor?: string; origin_type?: string; origin_id?: string; workspace_id?: string };
    const limit = clampInt(query.limit, 20, 1, 200);
    const originType = query.origin_type ? SessionOriginTypeSchema.parse(query.origin_type) : null;
    const originId = query.origin_id?.trim() || null;
    if (originId && (!originType || originType === "direct")) throw new HttpError(400, "invalid_request", "origin_id 仅能与 bot/widget origin_type 一起使用");
    const application = await resolveSessionApplication(options, request);
    const page = await application.listSessions({
      access: sessionListAccess(request), limit, cursor: decodeSessionListCursor(query.cursor),
      originType, originId, workspaceId: query.workspace_id?.trim() || null,
    });
    const items = await assembleSessionList(page.items, application, options, request);
    return validateResponse(SessionListResponseSchema, ok({ items, next_cursor: page.nextCursor ? encodeSessionListCursor(page.nextCursor) : null }, "获取会话列表成功"));
  });

  app.get("/sessions/facets", async (request) => {
    const application = await resolveSessionApplication(options, request);
    const raw = await application.listSessionFacets({ access: sessionListAccess(request) });
    const sourceNames = await loadSourceNames(options, request.identity.tenantId);
    const workspaces = await application.listWorkspaces();
    const data: SessionListFacets = {
      type_counts: { direct: raw.typeCounts.direct, bot: raw.typeCounts.bot, widget: raw.typeCounts.widget },
      origins: raw.origins.map((origin) => ({ type: origin.type, id: origin.id, display_name: requireSourceName(sourceNames, origin.type, origin.id), count: origin.count })),
      workspaces: workspaces.map((workspace) => {
        const count = raw.workspaces.find((item) => item.workspaceId === workspace.workspace_id)?.count ?? 0;
        return { workspace_id: workspace.workspace_id, display_name: workspace.display_name, root_path: request.container.deploymentKind === "local" ? workspace.root_path : null, count };
      }),
    };
    return validateResponse(SessionListFacetsResponseSchema, ok(data, "获取会话筛选项成功"));
  });

  app.get("/workspaces", async (request) => {
    const application = await resolveSessionApplication(options, request);
    const workspaces = await application.listWorkspaces();
    const facetCounts = await application.listSessionFacets({ access: sessionListAccess(request) });
    const counts = new Map(facetCounts.workspaces.map((item) => [item.workspaceId, item.count]));
    const data = {
      items: workspaces.map((workspace) => ({
        workspace_id: workspace.workspace_id,
        display_name: workspace.display_name,
        root_path: request.container.deploymentKind === "local" ? workspace.root_path : null,
        session_count: counts.get(workspace.workspace_id) ?? 0,
      })),
    };
    return validateResponse(WorkspaceListResponseSchema, ok(data, "获取项目列表成功"));
  });

  app.post("/workspaces", async (request) => {
    const payload = CreateWorkspaceRequestSchema.parse(request.body);
    const application = await resolveSessionApplication(options, request);
    try {
      const workspaceId = await application.resolveWorkspace({ kind: "local_path", root_path: payload.root_path });
      const workspace = (await application.listWorkspacesByIds(workspaceId ? [workspaceId] : []))[0];
      if (!workspace) throw new Error("项目创建失败");
      const data = {
        workspace_id: workspace.workspace_id,
        display_name: workspace.display_name,
        root_path: request.container.deploymentKind === "local" ? workspace.root_path : null,
      };
      return validateResponse(WorkspaceResponseSchema, ok(data, "项目创建成功"));
    } catch (error) {
      if (error instanceof Error && /Workspace|项目/.test(error.message)) {
        throw new HttpError(400, "invalid_request", error.message);
      }
      throw error;
    }
  });

  app.delete<{ Params: WorkspaceParams }>("/workspaces/:workspaceId", async (request) => {
    const application = await resolveSessionApplication(options, request);
    const removed = await application.removeWorkspace(request.params.workspaceId);
    if (!removed) throw new HttpError(404, "not_found", "项目不存在");
    return ok(undefined, "项目移除成功");
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const session = await sessions.getSession(request.params.sessionId);
    if (!session) throw new HttpError(404, "not_found", "会话不存在");
    await assertSessionReadable(request, session);
    return validateResponse(SessionDetailResponseSchema, ok(await assembleSessionDetail(session, sessions, options, request), "获取会话成功"));
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/ws-ticket", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    return validateResponse(
      SessionWsTicketResponseSchema,
      ok(await options.wsTickets.issue(request.identity, request.params.sessionId), "WebSocket ticket 已签发"),
    );
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/permissions", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const session = await loadReadableSession(request, request.params.sessionId, sessions);
    return validateResponse(
      SessionPermissionResponseSchema,
      ok({ mode: session.permission_mode ?? "standard" }, "获取会话权限成功"),
    );
  });

  app.patch<{ Params: SessionParams }>("/sessions/:sessionId/permissions", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadMutableSession(request, request.params.sessionId, sessions);
    const payload = UpdateSessionPermissionModeRequestSchema.parse(request.body);
    const updated = await sessions.updateSessionPermissionMode(request.params.sessionId, payload.mode);
    if (!updated) throw new HttpError(404, "not_found", "会话不存在");
    return validateResponse(
      SessionPermissionResponseSchema,
      ok({ mode: payload.mode }, "会话权限已更新"),
    );
  });

  app.delete<{ Params: SessionParams }>("/sessions/:sessionId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const session = await sessions.getSession(request.params.sessionId);
    if (!session) throw new HttpError(404, "not_found", "会话不存在");
    await assertSessionMutable(request, session);
    const deleted = await sessions.deleteSession(request.params.sessionId);
    if (!deleted) {
      throw new HttpError(404, "not_found", "会话不存在");
    }
    return ok(undefined, "会话删除成功");
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/participants", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    const participants = await request.container.agentDelegation.listSessionParticipants(request.params.sessionId);
    if (!participants) throw new HttpError(404, "not_found", "会话不存在");
    return validateResponse(SessionParticipantListResponseSchema, ok(participants, "获取会话参与者成功"));
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/messages", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    const session = await sessions.getSession(request.params.sessionId);
    if (!session) throw new HttpError(404, "not_found", "会话不存在");
    await assertSessionReadable(request, session);
    const query = request.query as { limit?: string; offset?: string; participant_id?: string };
    const limit = clampInt(query.limit, 20, 1, 1000);
    const offset = clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    const participant = await resolveSessionParticipant(request, request.params.sessionId, query.participant_id);
    const messages = await sessions.listMessages({
      sessionId: request.params.sessionId,
      limit,
      offset,
      threadKey: participant.thread_key,
    });
    if (!messages) throw new HttpError(404, "not_found", "会话不存在");
    return validateResponse(SessionMessageListResponseSchema, ok(messages, "获取对话记录成功"));
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/export", async (request, reply) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    try {
      const data = await sessions.exportSession(request.params.sessionId);
      const safeSessionId = sanitizeExportSessionId(request.params.sessionId);
      reply.header("content-type", "application/json; charset=utf-8");
      reply.header("content-disposition", `attachment; filename="session_${safeSessionId}.json"`);
      return data;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new HttpError(404, "not_found", message);
    }
  });

  app.get<{ Params: MessageParams }>(
    "/sessions/:sessionId/messages/:messageId/run-steps",
    async (request) => {
      const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
      try {
        const query = request.query as { limit?: string; offset?: string; participant_id?: string };
        const participant = await resolveSessionParticipant(request, request.params.sessionId, query.participant_id);
        const input = {
          sessionId: request.params.sessionId,
          messageId: request.params.messageId,
          limit: clampInt(query.limit, 500, 1, 2000),
          offset: clampInt(query.offset, 0, 0, Number.MAX_SAFE_INTEGER),
          threadKey: participant.thread_key,
        };
        const data = await sessions.listMessageRunSteps(input);
        return validateResponse(SessionMessageRunStepsResponseSchema, ok(data, "获取执行步骤成功"));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message.includes("仅 assistant")) {
          throw new HttpError(400, "invalid_request", message);
        }
        throw new HttpError(404, "not_found", message);
      }
    },
  );

  app.patch<{ Params: MessageParams }>("/sessions/:sessionId/messages/:messageId", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadMutableSession(request, request.params.sessionId, sessions);
    const payload = UpdateMessageRequestSchema.parse(request.body);
    const input = {
      sessionId: request.params.sessionId,
      messageId: request.params.messageId,
      content: payload.content,
    };
    const updated = await sessions.updateUserMessage(input);
    if (!updated) {
      throw new HttpError(404, "not_found", "消息不存在或不可编辑");
    }
    return ok({ message_id: request.params.messageId }, "更新成功");
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/rollback", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadMutableSession(request, request.params.sessionId, sessions);
    const payload = RollbackRequestSchema.parse(request.body);
    if (payload.after_seq == null && !payload.after_message_id) {
      throw new HttpError(400, "invalid_request", "请提供 after_seq 或 after_message_id");
    }
    const rollbackInput: { sessionId: string; afterSeq?: number | null; afterMessageId?: string | null } = {
      sessionId: request.params.sessionId,
    };
    if (payload.after_seq !== undefined) {
      rollbackInput.afterSeq = payload.after_seq;
    }
    if (payload.after_message_id !== undefined) {
      rollbackInput.afterMessageId = payload.after_message_id;
    }
    const deleted = await sessions.rollbackMessages(rollbackInput);
    return ok({ deleted }, "回退成功");
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/rollback-and-retry", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadMutableSession(request, request.params.sessionId, sessions);
    const payload = parseRollbackAndRetryRequest(request.body);
    if (payload.after_seq == null && !payload.after_message_id) {
      throw new HttpError(400, "invalid_request", "请提供 after_seq 或 after_message_id");
    }
    try {
      const retryInput: {
        sessionId: string;
        userId: typeof request.identity.userId;
        requestId: string;
        afterSeq?: number | null;
        afterMessageId?: string | null;
        modifyUserMessage?: string | null;
        selectedLlm?: string | null;
        attachments?: AttachmentRef[] | null;
        uiContext?: Record<string, unknown> | null;
      } = {
        sessionId: request.params.sessionId,
        userId: request.identity.userId,
        requestId: request.headers["x-request-id"]?.toString() ?? randomUUID(),
        selectedLlm: payload.selected_llm ?? payload.selectedLLM ?? null,
      };
      if (payload.after_seq !== undefined) {
        retryInput.afterSeq = payload.after_seq;
      }
      if (payload.after_message_id !== undefined) {
        retryInput.afterMessageId = payload.after_message_id;
      }
      if (payload.modify_user_message !== undefined) {
        retryInput.modifyUserMessage = payload.modify_user_message;
      }
      if (payload.attachments && payload.attachments.length) {
        retryInput.attachments = payload.attachments;
      }
      if (payload.ui_context) {
        retryInput.uiContext = payload.ui_context;
      }
      const result = await (await ensureRequestApplications(request, options)).execution.startRollbackRetry(retryInput);
      if (!result.started) {
        throw new HttpError(400, "invalid_request", result.error ?? "重试启动失败");
      }
      return ok(
        {
          ...result,
          answer: null,
          success: true,
          error: null,
          status: "started",
        },
        "重试已启动",
      );
    } catch (error) {
      if (error instanceof HttpError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("未找到会话")) {
        throw new HttpError(404, "not_found", message);
      }
      throw new HttpError(400, "invalid_request", message);
    }
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/background-tasks", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    const tasks = await request.container.backgroundTasks.listSessionTasks(request.params.sessionId);
    return ok({ tasks }, "获取后台任务成功");
  });

  app.post<{ Params: BackgroundTaskParams }>(
    "/sessions/:sessionId/background-tasks/:taskId/cancel",
    async (request) => {
      const sessions = await resolveSessionApplication(options, request);
    await loadMutableSession(request, request.params.sessionId, sessions);
      const taskId = parseBackgroundTaskId(request.params.taskId);
      const result = await request.container.backgroundTasks.cancelSessionTask(request.params.sessionId, taskId);
      return ok({ result }, result.cancelled ? "后台任务已取消" : "后台任务未取消");
    },
  );

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/background-tasks/cancel", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadMutableSession(request, request.params.sessionId, sessions);
    const payload = parseCancelBackgroundTasksRequest(request.body);
    const results = await request.container.backgroundTasks.cancelSessionTasks(
      request.params.sessionId,
      payload.task_ids,
    );
    return ok({ results }, "后台任务批量取消完成");
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/goals/current", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    const current = await request.container.goalStore.getCurrent(request.params.sessionId);
    const goal = current ?? (await request.container.goalStore.list(request.params.sessionId))[0] ?? null;
    return ok({ goal }, "获取当前 Goal 成功");
  });

  app.get<{ Params: SessionParams }>("/sessions/:sessionId/goals", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadReadableSession(request, request.params.sessionId, sessions);
    const goals = await request.container.goalStore.list(request.params.sessionId);
    return ok({ goals }, "获取 Goal 历史成功");
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/goals/current/start", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadMutableSession(request, request.params.sessionId, sessions);
    const current = await request.container.goalStore.getCurrent(request.params.sessionId)
      ?? (await request.container.goalStore.list(request.params.sessionId))[0]
      ?? null;
    if (!current) throw new HttpError(404, "not_found", "当前 Session 没有可开启的 Goal");
    const goal = current.status === "active"
      ? current
      : current.status === "blocked" && request.container.goalStore.restartBlocked
        ? await request.container.goalStore.restartBlocked(request.params.sessionId, current.id)
        : await request.container.goalStore.update(request.params.sessionId, current.id, { status: "active" });
    if (!goal) throw new HttpError(404, "not_found", "Goal 不存在");
    request.container.backgroundTasks.scheduleAutoTrigger(request.params.sessionId);
    return ok({ goal }, "Goal 已开启");
  });

  app.post<{ Params: SessionParams }>("/sessions/:sessionId/goals/current/pause", async (request) => {
    const sessions = await resolveSessionApplication(options, request);
    await loadMutableSession(request, request.params.sessionId, sessions);
    const current = await request.container.goalStore.getCurrent(request.params.sessionId);
    if (!current) throw new HttpError(404, "not_found", "当前 Session 没有可暂停的 Goal");
    const goal = current.status === "paused"
      ? current
      : await request.container.goalStore.update(request.params.sessionId, current.id, { status: "paused" });
    if (!goal) throw new HttpError(404, "not_found", "Goal 不存在");
    await request.container.agentExecution.stopSession(request.params.sessionId);
    return ok({ goal }, "Goal 已暂停");
  });

};

async function assembleSessionList(
  projections: readonly SessionListProjection[],
  application: SessionApplication,
  options: AgentRouteOptions,
  request: Parameters<typeof sessionListAccess>[0],
): Promise<SessionListItem[]> {
  const sourceNames = await loadSourceNames(options, request.identity.tenantId);
  const workspaces = await application.listWorkspacesByIds(
    projections.flatMap((item) => item.workspace_id ? [item.workspace_id] : []),
  );
  const workspaceMap = new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace]));
  return projections.map((item) => ({
    session_id: item.session_id,
    title: item.title,
    first_message: item.first_message,
    last_message: item.last_message,
    activity_at: item.activity_at,
    unread_count: item.unread_count,
    origin: {
      type: item.origin_type,
      id: item.origin_id,
      display_name: item.origin_type === "direct" ? "直接对话" : requireSourceName(sourceNames, item.origin_type, item.origin_id),
      channel: item.origin_channel,
    },
    workspace: toWorkspaceView(item.workspace_id, workspaceMap, request.container.deploymentKind === "local"),
  }));
}

async function assembleSessionDetail(
  session: SessionInfo,
  application: SessionApplication,
  options: AgentRouteOptions,
  request: Parameters<typeof sessionListAccess>[0],
) {
  const sourceNames = await loadSourceNames(options, request.identity.tenantId);
  const workspaces = await application.listWorkspacesByIds(session.workspace_id ? [session.workspace_id] : []);
  return {
    session_id: session.session_id,
    team_name: session.team_snapshot.team_name,
    team_revision: session.team_snapshot.team_revision,
    entry_agent_name: session.team_snapshot.entry_agent_name,
    tenant_id: session.tenant_id,
    owner_user_id: session.owner_user_id,
    visibility: session.visibility,
    origin: {
      type: session.origin_type,
      id: session.origin_id,
      display_name: session.origin_type === "direct" ? "直接对话" : requireSourceName(sourceNames, session.origin_type, session.origin_id),
      channel: session.origin_channel,
    },
    workspace: toWorkspaceView(session.workspace_id, new Map(workspaces.map((workspace) => [workspace.workspace_id, workspace])), request.container.deploymentKind === "local"),
    permission_mode: session.permission_mode,
    metadata: session.metadata,
    created_at: session.created_at,
    updated_at: session.updated_at,
  };
}

async function assembleCreatedSession(
  session: SessionInfo,
  application: SessionApplication,
  options: AgentRouteOptions,
  request: Parameters<typeof sessionListAccess>[0],
) {
  const { tenant_id: _tenantId, created_at: _createdAt, updated_at: _updatedAt, ...created } =
    await assembleSessionDetail(session, application, options, request);
  return created;
}

async function loadSourceNames(options: AgentRouteOptions, tenantId: SessionInfo["tenant_id"]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  await options.emitPluginEvent?.("session.origins.resolve", { tenantId, names });
  return names;
}

function requireSourceName(names: ReadonlyMap<string, string>, type: "bot" | "widget", id: string | null): string {
  if (!id) throw new Error(`${type} session is missing origin id`);
  const name = names.get(`${type}:${id}`);
  return names.get(`${type}:${id}`) ?? id;
}

function toWorkspaceView(
  workspaceId: string | null,
  workspaces: ReadonlyMap<string, { workspace_id: string; display_name: string; root_path: string }>,
  exposeRootPath: boolean,
) {
  if (!workspaceId) return null;
  const workspace = workspaces.get(workspaceId);
  if (!workspace) throw new Error(`session references missing workspace: ${workspaceId}`);
  return { workspace_id: workspace.workspace_id, display_name: workspace.display_name, root_path: exposeRootPath ? workspace.root_path : null };
}

function clampInt(rawValue: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = rawValue === undefined ? fallback : Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, parsed));
}

async function resolveSessionParticipant(
  request: Parameters<typeof sessionListAccess>[0],
  sessionId: string,
  rawParticipantId: string | undefined,
) {
  const participantId = rawParticipantId?.trim() || "root";
  const participant = await request.container.agentDelegation.getSessionParticipant(sessionId, participantId);
  if (!participant) throw new HttpError(404, "not_found", `会话参与者不存在: ${participantId}`);
  return participant;
}

function sanitizeExportSessionId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^[._]+|[._]+$/g, "") || "session";
}

function parseRollbackAndRetryRequest(body: unknown) {
  try {
    const parsed = RollbackAndRetryRequestSchema.parse(body);
    if (parsed.after_seq == null && !parsed.after_message_id) {
      throw new HttpError(422, "validation_error", "请求参数验证失败", ["body -> after_seq: Field required"]);
    }
    return parsed;
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
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

function parseBackgroundTaskId(taskId: string): string {
  return parseBackgroundTaskInput(BackgroundTaskIdSchema, taskId, "params -> taskId");
}

function parseCancelBackgroundTasksRequest(body: unknown): z.infer<typeof CancelBackgroundTasksRequestSchema> {
  return parseBackgroundTaskInput(CancelBackgroundTasksRequestSchema, body, "body");
}

function parseBackgroundTaskInput<T>(schema: z.ZodType<T>, input: unknown, location: string): T {
  try {
    return schema.parse(input);
  } catch (error) {
    if (error instanceof ZodError) {
      throw new HttpError(
        422,
        "validation_error",
        "请求参数验证失败",
        error.issues.map((issue) => `${location}${issue.path.length ? ` -> ${issue.path.join(" -> ")}` : ""}: ${issue.message}`),
      );
    }
    throw error;
  }
}
