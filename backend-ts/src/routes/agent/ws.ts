import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ClientToServerEnvelopeSchema, type Envelope } from "../../contracts/events.js";
import { EnvelopeProjector } from "../../services/runtime/event-outbox/projector.js";
import type { RuntimeContainer } from "../../services/runtime/runtime-container.js";
import type { AgentRouteOptions } from "../route-options.js";
import { isRecord } from "../../utils/guards.js";
import { widgetUserId } from "../../identity/widget-user-id.js";
import { assertSessionOwner } from "../session-owner.js";
import { ensureRequestApplications } from "../../app/request-applications.js";

interface SessionWsParams {
  sessionId: string;
}

interface SessionWsQuery {
  after_seq?: string;
  /** 普通前端会话使用的短时、单次 WebSocket ticket。 */
  ticket?: string;
}

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "close" | "error", listener: () => void): void;
};

const WS_OPEN = 1;

export const registerSessionWebSocketRoute: FastifyPluginAsync<AgentRouteOptions> = async (app, options) => {
  app.get<{ Params: SessionWsParams; Querystring: SessionWsQuery }>(
    "/sessions/:sessionId/ws",
    {
      websocket: true,
      preValidation: async (request) => {
        const sessionId = request.params.sessionId;
        let lease;
        try {
          if (request.query.ticket) {
            const identity = options.wsTickets.consume(request.query.ticket, sessionId);
            request.identity = identity;
            request.userId = identity.userId;
            lease = await options.registry.acquire(identity.tenantId);
          } else {
            // local profile 和受信任的非浏览器客户端仍可由 identity provider 直接解析；
            // 浏览器 password profile 必须先走 HTTP 签发 ticket，不再接受长期 JWT query。
            const identity = await options.identityProvider.resolve(request);
            request.identity = identity;
            request.userId = identity.userId;
            lease = await options.registry.acquire(identity.tenantId);
          }
          request.tenantId = lease.tenantId;
          request.container = lease.runtime;
          request.tenantRuntimeLease = lease;
        } catch (error) {
          lease?.release();
          throw error;
        }
      },
    },
    async (socket: unknown, request) => {
      const ws = socket as WebSocketLike;
      const sessionId = request.params.sessionId;
      const lease = request.tenantRuntimeLease;
      if (!lease) {
        ws.close(4001, "unauthorized");
        return;
      }
      request.tenantRuntimeLease = null;
      const container = request.container;
      const wsActivity = options.registry.trackWebSocket(lease.tenantId);
      const applications = await ensureRequestApplications(request, options);
      const executionRead = applications.executionRead;
      const session = await applications.sessions.getSession(sessionId);
      const widgetMeta = (session?.metadata as { widget?: { app_key?: string } } | undefined)?.widget;
      if (widgetMeta?.app_key && request.identity.userId !== widgetUserId(widgetMeta.app_key)) {
        wsActivity.release();
        lease.release();
        ws.close(4001, "unauthorized");
        return;
      }
      if (!session) {
        wsActivity.release();
        lease.release();
        ws.close(4004, "session not found");
        return;
      }
      try {
        const widgetMeta = (session.metadata as { widget?: { app_key?: string } }).widget;
        if (widgetMeta?.app_key) {
          request.identity = {
            userId: widgetUserId(widgetMeta.app_key),
            tenantId: lease.tenantId,
            role: "widget",
            permissions: ["sessions:create"],
          };
          request.userId = request.identity.userId;
        }
        await assertSessionOwner(request, session);
      } catch {
        wsActivity.release();
        lease.release();
        ws.close(4003, "forbidden");
        return;
      }
      const afterSeq = parseSeqCursor(request.query.after_seq);
      let lastSeq = 0;
      let boundRunId: string | null = null;

      // seq 兼任持久化去重 + 连续性游标：envelope 自带 seq（row.session_seq，由 projector 盖戳），
      // 此处只追踪已发最大 seq 供 heartbeat/重连 cursor；不再注入连接内 stream_seq。
      const send = (payload: Envelope): void => {
        if (ws.readyState !== WS_OPEN) {
          return;
        }
        if (typeof payload.seq === "number" && payload.seq > lastSeq) {
          lastSeq = payload.seq;
        }
        ws.send(JSON.stringify(payload));
      };
      const sendAck = (
        category: "send" | "stop" | "interaction" | "tool_delegate",
        ok: boolean,
        extra: { ref_call_id?: string; error?: string } = {},
      ): void => {
        send({ type: "ack", session_id: sessionId, payload: { category, ok, ...extra } });
      };
      const sendReconnect = (
        phase: "start" | "end",
        replayCount: number,
        runId?: string | null,
        replaySource?: "durable_outbox" | "memory",
      ): void => {
        send({
          type: "session.reconnect",
          session_id: sessionId,
          ...(runId ? { run_id: runId } : {}),
          payload: { phase, replay_count: replayCount, ...(replaySource ? { replay_source: replaySource } : {}) },
        });
      };

      const unsubscribe = container.realtimeEvents.subscribe(sessionId, (event) => {
        send(event);
        if (event.type !== "run_started") {
          return;
        }
        const runId = typeof event.run_id === "string" ? event.run_id : null;
        if (!runId || runId === boundRunId) {
          return;
        }
        boundRunId = runId;
        sendReconnect("start", 0, runId);
        sendReconnect("end", 0, runId);
      });
      const heartbeat = setInterval(() => {
        send({
          type: "heartbeat",
          session_id: sessionId,
          payload: { last_seq: lastSeq },
        });
      }, 20_000);

      const durableReplay = await buildDurableOutboxReplay(executionRead, sessionId, afterSeq);
      if (durableReplay) {
        boundRunId = durableReplay.runId;
        sendReconnect("start", durableReplay.events.length, durableReplay.runId, "durable_outbox");
        for (const env of durableReplay.events) {
          send(env);
        }
        sendReconnect("end", durableReplay.events.length, durableReplay.runId, "durable_outbox");
      }

      const activeReplay = await buildActiveRunReplay(executionRead, container, sessionId);
      if (activeReplay) {
        boundRunId = activeReplay.runId;
        sendReconnect("start", activeReplay.events.length, activeReplay.runId);
        for (const env of activeReplay.events) {
          send(env);
        }
        sendReconnect("end", activeReplay.events.length, activeReplay.runId);
      }

      ws.on("message", (data) => {
        const raw = data.toString();
        try {
          const message = ClientToServerEnvelopeSchema.parse(JSON.parse(raw));
          switch (message.type) {
            case "user_driven_change": {
              const payload = message.payload;
              container.agentExecution
                .startStream(
                  {
                    task: payload.task,
                    session_id: sessionId,
                    userId: request.userId,
                    selected_llm: payload.selected_llm,
                    attachments: payload.attachments,
                    ui_context: payload.ui_context,
                  },
                  payload.request_id ?? randomUUID(),
                )
                .then((result) => {
                  sendAck("send", result.started, result.started ? {} : { error: "Agent stream 未启动" });
                })
                .catch((error) => {
                  sendAck("send", false, { error: error instanceof Error ? error.message : "Agent stream execution failed" });
                });
              break;
            }
            case "abort":
              container.agentExecution.stopSession(sessionId).catch(() => undefined);
              sendAck("stop", true);
              break;
            case "tools.register":
              // 握手期前端推送本连接可委托执行的工具清单（覆盖式）。runtime-adapter per-run 取用。
              container.hostToolRegistry.register(sessionId, message.payload.tools);
              break;
            case "delegate_result": {
              // 委托执行回传：按 call_id 唤醒转发壳 Tool.call 的等待器。
              const payload = message.payload;
              const resolved = container.delegationPending.resolve(message.call_id, {
                ok: payload.ok,
                ...(payload.observation !== undefined ? { observation: payload.observation } : {}),
                ...(payload.error !== undefined ? { error: payload.error } : {}),
                ...(payload.elapsed_ms !== undefined ? { elapsedMs: payload.elapsed_ms } : {}),
              });
              sendAck("tool_delegate", resolved, { ref_call_id: message.call_id, ...(resolved ? {} : { error: "未找到对应的委托等待，可能已超时或取消" }) });
              break;
            }
            case "interaction": {
              const payload = message.payload;
              if (payload.kind === "approval") {
                const result = container.pendingInteractions.respondApproval(sessionId, message.call_id, {
                  approved: payload.approved ?? false,
                  message: payload.message,
                });
                if (result.needsResume) {
                  container.resumeExecutor.resumeRun({
                    sessionId,
                    approvalId: message.call_id,
                    resolution: { approved: payload.approved ?? false, message: payload.message ?? "" },
                  });
                }
                sendAck("interaction", result.resolved, { ref_call_id: message.call_id, ...(result.resolved ? {} : { error: "未找到对应的审批请求，可能已被取消或不存在" }) });
              } else {
                const result = container.pendingInteractions.respondUserInput(sessionId, message.call_id, { value: payload.value });
                if (result.needsResume) {
                  container.resumeExecutor.resumeRun({
                    sessionId,
                    approvalId: message.call_id,
                    resolution: { value: payload.value ?? "" },
                  });
                }
                sendAck("interaction", result.resolved, { ref_call_id: message.call_id, ...(result.resolved ? {} : { error: "未找到对应的输入请求，可能已被取消或不存在" }) });
              }
              break;
            }
          }
        } catch (error) {
          send({
            type: "error",
            session_id: sessionId,
            payload: {
              code: "invalid_message",
              message: error instanceof Error ? error.message : "Invalid WebSocket payload",
            },
          });
        }
      });

      let cleanedUp = false;
      const cleanup = (): void => {
        if (cleanedUp) return;
        cleanedUp = true;
        clearInterval(heartbeat);
        unsubscribe();
        wsActivity.release();
        lease.release();
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    },
  );
};

async function buildDurableOutboxReplay(
  reads: import("../../contracts/execution-read-application.js").ExecutionReadApplication,
  sessionId: string,
  afterSeq: number | null,
): Promise<{ runId: string | null; events: Envelope[] } | null> {
  if (afterSeq === null) {
    return null;
  }
  const rows = await reads.listOutboxForReplay({
    sessionId,
    afterSeq,
    limit: 500,
  });
  if (rows.length === 0) {
    return null;
  }
  const projector = new EnvelopeProjector();
  return {
    runId: rows.find((row) => row.run_id)?.run_id ?? null,
    events: rows.map((row) => projector.toEnvelope(row)).filter((event) => !isDelegateCallEvent(event)),
  };
}

async function buildActiveRunReplay(
  reads: import("../../contracts/execution-read-application.js").ExecutionReadApplication,
  container: RuntimeContainer,
  sessionId: string,
): Promise<{ runId: string; events: Envelope[] } | null> {
  const status = (await reads.getSessionTaskStatus(sessionId)).task_info;
  if (!status || status.status !== "running" || !status.run_id) {
    return null;
  }

  const runId = status.run_id;
  const startedAtMs = timestampToMilliseconds(status.started_at);
  // active run 树：root + 递归子孙 run。重放要含子 agent 事件，工作栏才看得到子 agent 步骤。
  const allRuns = await reads.listRuns(sessionId, 1000);
  const runIdSet = new Set<string>([runId]);
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of allRuns) {
      if (r.parent_run_id && runIdSet.has(r.parent_run_id) && !runIdSet.has(r.run_id)) {
        runIdSet.add(r.run_id);
        changed = true;
      }
    }
  }
  const projector = new EnvelopeProjector();
  const events = (await reads.listOutboxForReplay({
    sessionId,
    runIds: [...runIdSet],
    limit: 500,
  })).map((row) => projector.toEnvelope(row)).filter((event) => {
    if (isDelegateCallEvent(event)) {
      return false;
    }
    if (!isPendingInteractionReplayEvent(container, sessionId, event)) {
      return false;
    }
    if (startedAtMs === null) {
      return true;
    }
    const eventTimeMs = timestampToMilliseconds(event.timestamp);
    return eventTimeMs === null || eventTimeMs >= startedAtMs;
  });

  return { runId, events };
}

function parseSeqCursor(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/**
 * 回放过滤：未决 interaction(required) 才回放（已响应的不重推，避免前端重复弹窗）。
 * 新协议 interaction 顶层 call_id 即交互 id（pendingInteractions 的 approval/input key）。
 */
function isPendingInteractionReplayEvent(
  container: RuntimeContainer,
  sessionId: string,
  event: Envelope,
): boolean {
  if (event.type !== "interaction") {
    return true;
  }
  const payload = isRecord(event.payload) ? (event.payload as { phase?: unknown; kind?: unknown }) : {};
  if (payload.phase !== "required") {
    return true;
  }
  const callId = typeof event.call_id === "string" ? event.call_id : null;
  if (!callId) {
    return true;
  }
  return payload.kind === "approval"
    ? container.pendingInteractions.isApprovalPending(sessionId, callId)
    : container.pendingInteractions.isUserInputPending(sessionId, callId);
}

/**
 * delegate_call 不回放：委托是实时双向指令，重连时 in-flight 已失效，
 * 回放会让前端误以为是新的委托请求。投影 tool_call/tool_result 正常回放。
 */
function isDelegateCallEvent(event: Envelope): boolean {
  return event.type === "delegate_call";
}

function timestampToMilliseconds(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
