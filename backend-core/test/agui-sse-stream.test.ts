import { EventEmitter } from "node:events";

import type { FastifyReply } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { openAguiSse } from "../src/services/agui-gateway/sse-stream.js";

describe("AG-UI SSE stream lifecycle", () => {
  it("stays open when the POST request closes and cleans up when the response closes", () => {
    const requestRaw = new EventEmitter();
    const responseRaw = Object.assign(new EventEmitter(), {
      destroyed: false,
      writableEnded: false,
      writeHead: vi.fn(),
      flushHeaders: vi.fn(),
      write: vi.fn(),
      end: vi.fn(),
    });
    const reply = {
      getHeaders: () => ({ "access-control-allow-origin": "http://127.0.0.1:5122" }),
      hijack: vi.fn(),
      raw: responseRaw,
      request: { raw: requestRaw },
    } as unknown as FastifyReply;

    const stream = openAguiSse(reply);
    const onClose = vi.fn();
    stream.onClose(onClose);

    requestRaw.emit("close");
    stream.send("data: first\n\n");

    expect(stream.closed).toBe(false);
    expect(responseRaw.write).toHaveBeenCalledWith("data: first\n\n");
    expect(onClose).not.toHaveBeenCalled();

    responseRaw.emit("close");

    expect(stream.closed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
    expect(responseRaw.end).toHaveBeenCalledOnce();
  });
});
