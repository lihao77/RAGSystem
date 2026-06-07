import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ClientToServerMessageSchema, type ClientEvent } from "../../contracts/events.js";
import { ClientEventProjector } from "../../services/runtime/event-outbox/projector.js";
import type { RouteOptions } from "../route-options.js";

interface SessionWsParams {
  sessionId: string;
}

interface SessionWsQuery {
  after_event_seq?: string;
}

type WebSocketLike = {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "message", listener: (data: Buffer | string) => void): void;
  on(event: "close" | "error", listener: () => void): void;
};

const WS_OPEN = 1;

export const registerSessionWebSocketRoute: FastifyPluginAsync<RouteOptions> = async (app, options) => {
  app.get<{ Params: SessionWsParams; Querystring: SessionWsQuery }>(
    "/sessions/:sessionId/ws",
    { websocket: true },
    (socket: unknown, request) => {
      const ws = socket as WebSocketLike;
      const sessionId = request.params.sessionId;
      const afterEventSeq = parseEventSeqCursor(request.query.after_event_seq);
      let streamSeq = 0;
      let lastEventSeq = 0;
      let boundRunId: string | null = null;

      const send = (payload: ClientEvent, increment = true): void => {
        if (ws.readyState !== WS_OPEN) {
          return;
        }
        if (typeof payload.event_seq === "number" && payload.event_seq > lastEventSeq) {
          lastEventSeq = payload.event_seq;
        }
        const stamped = increment ? { ...payload, stream_seq: ++streamSeq } : payload;
        ws.send(JSON.stringify(stamped));
      };
      const sendRunBindingEnvelope = (runId: string, replayCount: number): void => {
        send({
          type: "reconnect_start",
          session_id: sessionId,
          run_id: runId,
          replay_count: replayCount,
        });
        send({
          type: "reconnect_end",
          session_id: sessionId,
        });
      };
      const sendInteractionAck = (
        interactionId: string,
        kind: "user_input" | "approval",
        data: Record<string, unknown> = {},
      ): void => {
        const payload = {
          interaction_id: interactionId,
          kind,
          resolved: true,
          ...data,
        };
        send({
          type: "interaction.ack",
          session_id: sessionId,
          interaction_id: interactionId,
          kind,
          data: payload,
          content: payload,
        });
      };
      const sendInteractionError = (
        interactionId: string,
        kind: "user_input" | "approval",
        error: string,
      ): void => {
        const payload = {
          interaction_id: interactionId,
          kind,
          resolved: false,
        };
        send({
          type: "interaction.error",
          session_id: sessionId,
          interaction_id: interactionId,
          kind,
          error,
          data: payload,
          content: payload,
        });
      };
      const unsubscribe = options.container.realtimeEvents.subscribe(sessionId, (event) => {
        send(event);
        if (event.type !== "session.run_started") {
          return;
        }
        const runId = extractRunId(event);
        if (!runId || runId === boundRunId) {
          return;
        }
        boundRunId = runId;
        sendRunBindingEnvelope(runId, 0);
      });
      const heartbeat = setInterval(() => {
        send(
          {
            type: "heartbeat",
            timestamp: Date.now(),
            last_stream_seq: streamSeq,
            last_event_seq: lastEventSeq,
          },
          false,
        );
      }, 20_000);

      const durableReplay = buildDurableOutboxReplay(options.container, sessionId, afterEventSeq);
      if (durableReplay) {
        boundRunId = durableReplay.runId;
        send({
          type: "reconnect_start",
          session_id: sessionId,
          ...(durableReplay.runId ? { run_id: durableReplay.runId } : {}),
          replay_count: durableReplay.events.length,
          replay_source: "durable_outbox",
        });
        for (const event of durableReplay.events) {
          send(event);
        }
        send({
          type: "reconnect_end",
          session_id: sessionId,
          replay_source: "durable_outbox",
        });
      }

      const activeReplay = buildActiveRunReplay(options.container, sessionId);
      if (activeReplay) {
        boundRunId = activeReplay.runId;
        send({
          type: "reconnect_start",
          session_id: sessionId,
          run_id: activeReplay.runId,
          replay_count: activeReplay.events.length,
        });
        for (const event of activeReplay.events) {
          send(event);
        }
        send({
          type: "reconnect_end",
          session_id: sessionId,
        });
      }

      ws.on("message", (data) => {
        const raw = data.toString();
        try {
          const message = ClientToServerMessageSchema.parse(JSON.parse(raw));
          switch (message.type) {
            case "send":
              options.container.agentExecution
                .startStream(
                  {
                    task: message.task,
                    session_id: sessionId,
                    user_id: message.user_id,
                    selected_llm: message.selected_llm,
                    attachments: [],
                  },
                  message.request_id ?? randomUUID(),
                )
                .then((result) => {
                  send({
                    type: result.started ? "send.ack" : "send.error",
                    ...result,
                    session_id: sessionId,
                  });
                })
                .catch((error) => {
                  send({
                    type: "send.error",
                    session_id: sessionId,
                    error: error instanceof Error ? error.message : "Agent stream execution failed",
                  });
                });
              break;
            case "stop":
              options.container.agentExecution.stopSession(sessionId).catch(() => undefined);
              send({
                type: "stop.ack",
                session_id: sessionId,
              });
              break;
            case "approve":
              if (!options.container.pendingInteractions.respondApproval(sessionId, message.approval_id, {
                approved: message.approved,
                message: message.message,
              })) {
                send({
                  type: "approve.error",
                  session_id: sessionId,
                  approval_id: message.approval_id,
                  error: "未找到对应的审批请求，可能已被取消或不存在",
                });
              }
              break;
            case "interaction.respond": {
              const result = options.container.pendingInteractions.respondInteraction(
                sessionId,
                message.interaction_id,
                message,
              );
              if (result.resolved) {
                sendInteractionAck(message.interaction_id, result.kind, {
                  value: message.value,
                  approved: result.approved ?? message.approved ?? null,
                  message: result.message ?? message.message ?? "",
                  ...(result.kind === "approval" ? { approval_id: message.interaction_id } : {}),
                });
              } else {
                sendInteractionError(
                  message.interaction_id,
                  result.kind,
                  result.error ?? "未找到对应的交互请求，可能已被取消或不存在",
                );
              }
              break;
            }
            case "user_input":
              if (options.container.pendingInteractions.respondUserInput(sessionId, message.input_id, { value: message.value })) {
                send({
                  type: "user_input.ack",
                  session_id: sessionId,
                  input_id: message.input_id,
                  data: {
                    input_id: message.input_id,
                    resolved: true,
                  },
                  content: {
                    input_id: message.input_id,
                    resolved: true,
                  },
                });
              } else {
                send({
                  type: "user_input.error",
                  session_id: sessionId,
                  input_id: message.input_id,
                  error: "未找到对应的输入请求，可能已被取消或不存在",
                });
              }
              break;
          }
        } catch (error) {
          send({
            type: "error",
            session_id: sessionId,
            error: error instanceof Error ? error.message : "Invalid WebSocket payload",
          });
        }
      });

      const cleanup = (): void => {
        clearInterval(heartbeat);
        unsubscribe();
      };
      ws.on("close", cleanup);
      ws.on("error", cleanup);
    },
  );
};

function buildDurableOutboxReplay(
  container: RouteOptions["container"],
  sessionId: string,
  afterEventSeq: number | null,
): { runId: string | null; events: ClientEvent[] } | null {
  if (afterEventSeq === null) {
    return null;
  }
  const rows = container.conversationStore.listOutboxForReplay({
    sessionId,
    afterSeq: afterEventSeq,
    limit: 500,
  });
  if (rows.length === 0) {
    return null;
  }
  const projector = new ClientEventProjector();
  return {
    runId: rows.find((row) => row.run_id)?.run_id ?? null,
    events: rows.map((row) => projector.toClientEvent(row)),
  };
}

function buildActiveRunReplay(
  container: RouteOptions["container"],
  sessionId: string,
): { runId: string; events: ClientEvent[] } | null {
  const status = container.agentExecution.getSessionTaskStatus(sessionId).task_info;
  if (!status || status.status !== "running" || !status.run_id) {
    return null;
  }

  const runId = status.run_id;
  const startedAtMs = timestampToMilliseconds(status.started_at);
  const projector = new ClientEventProjector();
  const events = container.conversationStore.listOutboxForReplay({
    sessionId,
    runId,
    limit: 500,
  }).map((row) => projector.toClientEvent(row)).filter((event) => {
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

function parseEventSeqCursor(value: string | undefined): number | null {
  if (value === undefined) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function isPendingInteractionReplayEvent(
  container: RouteOptions["container"],
  sessionId: string,
  event: ClientEvent,
): boolean {
  if (event.type === "user.approval_required") {
    const approvalId = extractInteractionId(event, "approval");
    return !approvalId || container.pendingInteractions.isApprovalPending(sessionId, approvalId);
  }
  if (event.type === "user.input_required") {
    const inputId = extractInteractionId(event, "user_input");
    return !inputId || container.pendingInteractions.isUserInputPending(sessionId, inputId);
  }
  if (event.type !== "interaction.required") {
    return true;
  }

  const kind = extractInteractionKind(event);
  if (kind === "approval") {
    const approvalId = extractInteractionId(event, "approval");
    return !approvalId || container.pendingInteractions.isApprovalPending(sessionId, approvalId);
  }
  if (kind === "user_input") {
    const inputId = extractInteractionId(event, "user_input");
    return !inputId || container.pendingInteractions.isUserInputPending(sessionId, inputId);
  }
  return true;
}

function extractInteractionKind(event: ClientEvent): "approval" | "user_input" | null {
  const topLevelKind = event.kind;
  if (topLevelKind === "approval" || topLevelKind === "user_input") {
    return topLevelKind;
  }
  const dataKind = extractStringField(event.data, "kind");
  if (dataKind === "approval" || dataKind === "user_input") {
    return dataKind;
  }
  const contentKind = extractStringField(event.content, "kind");
  return contentKind === "approval" || contentKind === "user_input" ? contentKind : null;
}

function extractInteractionId(event: ClientEvent, kind: "approval" | "user_input"): string | null {
  const primary = kind === "approval" ? "approval_id" : "input_id";
  const topLevelId = event[primary] ?? event.interaction_id;
  if (typeof topLevelId === "string" && topLevelId.trim()) {
    return topLevelId;
  }
  return (
    extractStringField(event.data, primary) ??
    extractStringField(event.data, "interaction_id") ??
    extractStringField(event.content, primary) ??
    extractStringField(event.content, "interaction_id")
  );
}

function extractStringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const item = value[field];
  return typeof item === "string" && item.trim() ? item : null;
}

function extractRunId(event: ClientEvent): string | null {
  if (typeof event.run_id === "string" && event.run_id.trim()) {
    return event.run_id;
  }
  const dataRunId = extractRunIdFromValue(event.data);
  if (dataRunId) {
    return dataRunId;
  }
  return extractRunIdFromValue(event.content);
}

function extractRunIdFromValue(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  const runId = value.run_id ?? value.runId;
  return typeof runId === "string" && runId.trim() ? runId : null;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
