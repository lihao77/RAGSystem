import type { WebSocket } from "ws";
import type { Router } from "./router.js";

/** 前端→server 入站消息（自定义 WS 协议）。 */
type WSInbound =
  | {
      type: "register";
      session_id: string;
      tools: Array<{ name: string; description?: string; input_schema: Record<string, unknown>; risk_level?: string }>;
    }
  | {
      type: "result";
      call_id: string;
      ok: boolean;
      observation?: string;
      error?: string;
      elapsed_ms?: number;
    };

/** 对前端执行端的自定义 WS 面：register（执行绑定）/ result（回传）。invoke 由 router 下发。 */
export function handleWsMessage(ws: WebSocket, text: string, router: Router): void {
  let msg: WSInbound;
  try {
    msg = JSON.parse(text) as WSInbound;
  } catch {
    return;
  }
  if (msg.type === "register") {
    router.register(
      msg.session_id,
      ws,
      msg.tools.map((t) => ({ name: t.name, input_schema: t.input_schema ?? {} })),
    );
  } else if (msg.type === "result") {
    router.deliverResult(msg.call_id, {
      ok: msg.ok,
      observation: typeof msg.observation === "string" ? msg.observation : "",
      ...(msg.error ? { error: msg.error } : {}),
      ...(typeof msg.elapsed_ms === "number" ? { elapsedMs: msg.elapsed_ms } : {}),
    });
  }
}
