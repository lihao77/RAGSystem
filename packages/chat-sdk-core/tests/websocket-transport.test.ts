import { describe, expect, it, vi } from "vitest";

import { ChatWebSocketTransport } from "../src/websocket-transport.js";

class Socket {
  readonly readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event?: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;

  open(): void { this.onopen?.(); }
  send(): void {}
  close(code = 1000, reason = ""): void { this.onclose?.({ code, reason }); }
}

describe("ChatWebSocketTransport retry policy", () => {
  it("stops on terminal server close codes", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const statuses: string[] = [];
    const transport = new ChatWebSocketTransport({
      resolveUrl: async () => "wss://rag.example.test/session",
      sessionId: "s-1",
      reconnect: { enabled: true, maxRetries: 10, baseDelayMs: 1, maxDelayMs: 1 },
      createWebSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      handlers: {
        onEnvelope: () => {},
        onStatus: (status) => statuses.push(status.state),
      },
    });
    transport.connect();
    await vi.advanceTimersByTimeAsync(0);
    sockets[0]?.open();
    sockets[0]?.close(4004, "session not found");
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(1);
    expect(statuses.at(-1)).toBe("disconnected");
    transport.disconnect();
    vi.useRealTimers();
  });

  it("honors maxRetries for connections that open and immediately close", async () => {
    vi.useFakeTimers();
    const sockets: Socket[] = [];
    const transport = new ChatWebSocketTransport({
      resolveUrl: async () => "wss://rag.example.test/session",
      sessionId: "s-1",
      reconnect: { enabled: true, maxRetries: 2, baseDelayMs: 1, maxDelayMs: 1 },
      createWebSocket: () => {
        const socket = new Socket();
        sockets.push(socket);
        queueMicrotask(() => { socket.open(); socket.close(1011, "internal"); });
        return socket as unknown as WebSocket;
      },
      handlers: { onEnvelope: () => {}, onStatus: () => {} },
    });
    transport.connect();
    await vi.advanceTimersByTimeAsync(10);
    expect(sockets).toHaveLength(3);
    transport.disconnect();
    vi.useRealTimers();
  });
});
