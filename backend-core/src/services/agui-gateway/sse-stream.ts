import type { FastifyReply } from "fastify";
import type { OutgoingHttpHeaders } from "node:http";

/**
 * Fastify SSE 流：hijack reply 后手写 text/event-stream。
 * backend-ts 首个 SSE 端点，无现成模式；按 AG-UI 契约逐事件 `data: {json}\n\n`。
 */
export interface AguiSseStream {
  /** 写一段已编码文本（通常是 encodeAguiSse 结果）；连接关闭时静默丢弃。 */
  send(chunk: string): void;
  readonly closed: boolean;
  /** 注册连接关闭回调（unsubscribe 等清理）；可多次注册。 */
  onClose(handler: () => void): void;
  /** 主动结束流（写最后一个事件后调用）。 */
  end(): void;
}

export function openAguiSse(reply: FastifyReply): AguiSseStream {
  // @fastify/cors has calculated these headers already. Preserve them before
  // hijacking because raw.writeHead bypasses Fastify's normal response path.
  const responseHeaders = Object.fromEntries(
    Object.entries(reply.getHeaders()).filter((entry): entry is [string, string | number | string[]] => entry[1] !== undefined),
  ) as OutgoingHttpHeaders;
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    ...responseHeaders,
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  raw.flushHeaders();

  const closeHandlers: Array<() => void> = [];
  let closed = false;

  const markClosed = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    for (const handler of closeHandlers) {
      try {
        handler();
      } catch {
        // cleanup best-effort
      }
    }
    try {
      raw.end();
    } catch {
      // already closed
    }
  };

  // POST 请求体读取完成后 request 也会触发 close，但此时 SSE 响应仍需继续。
  // 只监听响应流关闭，避免在 Host Tool interrupt 写完前截断事件。
  raw.on("close", markClosed);

  return {
    get closed() {
      return closed;
    },
    send(chunk: string) {
      if (closed) {
        return;
      }
      if (raw.destroyed || raw.writableEnded) {
        markClosed();
        return;
      }
      raw.write(chunk);
    },
    onClose(handler: () => void) {
      closeHandlers.push(handler);
    },
    end() {
      markClosed();
    },
  };
}
