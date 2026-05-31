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
              send({
                type: "approve.error",
                session_id: sessionId,
                approval_id: message.approval_id,
                error: "Tool approval resolution has not been migrated to TypeScript yet",
              });
              break;
            case "user_input":
              send({
                type: "user_input.error",
                session_id: sessionId,
                input_id: message.input_id,
                error: "User input resolution has not been migrated to TypeScript yet",
              });
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
