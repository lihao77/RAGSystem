import { randomUUID } from "node:crypto";

import type { FastifyPluginAsync } from "fastify";

import { ClientToServerMessageSchema, type ClientEvent } from "../../contracts/events.js";
import type { RouteOptions } from "../route-options.js";

interface SessionWsParams {
  sessionId: string;
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
  app.get<{ Params: SessionWsParams }>(
    "/sessions/:sessionId/ws",
    { websocket: true },
    (socket: unknown, request) => {
      const ws = socket as WebSocketLike;
      const sessionId = request.params.sessionId;
      let streamSeq = 0;

      const send = (payload: ClientEvent, increment = true): void => {
        if (ws.readyState !== WS_OPEN) {
          return;
        }
        const stamped = increment ? { ...payload, stream_seq: ++streamSeq } : payload;
        ws.send(JSON.stringify(stamped));
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
      const sendApprovalResolved = (approvalId: string, approved: boolean, message: string): void => {
        const payload = {
          interaction_id: approvalId,
          kind: "approval",
          approval_id: approvalId,
          approved,
          message,
        };
        send({
          type: approved ? "user.approval_granted" : "user.approval_denied",
          session_id: sessionId,
          approval_id: approvalId,
          data: payload,
          content: payload,
        });
      };

      const unsubscribe = options.container.events.subscribe(sessionId, (event) => send(event));
      const heartbeat = setInterval(() => {
        send(
          {
            type: "heartbeat",
            timestamp: Date.now(),
            last_stream_seq: streamSeq,
          },
          false,
        );
      }, 20_000);

      send({
        type: "reconnect_start",
        session_id: sessionId,
        replay_count: options.container.events.getHistory(sessionId).length,
      });
      for (const event of options.container.events.getHistory(sessionId)) {
        send(event);
      }
      send({
        type: "reconnect_end",
        session_id: sessionId,
      });

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
              if (
                options.container.pendingInteractions.respondApproval(sessionId, message.approval_id, {
                  approved: message.approved,
                  message: message.message,
                })
              ) {
                sendInteractionAck(message.approval_id, "approval", {
                  approval_id: message.approval_id,
                  approved: message.approved,
                  message: message.message,
                });
                sendApprovalResolved(message.approval_id, message.approved, message.message);
              } else {
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
                if (result.kind === "approval") {
                  sendApprovalResolved(message.interaction_id, result.approved ?? false, result.message ?? "");
                }
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
