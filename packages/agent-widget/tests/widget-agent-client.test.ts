import { afterEach, describe, expect, it, vi } from "vitest";

import { WidgetAgentClient } from "../src/adapter/widget-agent-client.js";

class FakeWebSocket {
  static readonly OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readonly readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => this.onopen?.());
  }

  send(): void {}
  close(): void {}
}

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWebSocket.instances = [];
});

describe("WidgetAgentClient websocket ticket", () => {
  it("uses the Widget JWT only for HTTP ticket issuance", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ data: { ticket: "one-time-ticket" } }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
    const client = new WidgetAgentClient({
      backendBase: "https://api.example.test",
      sessionId: "session-1",
      token: "widget-jwt",
    });

    await client.connect();

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/api/widget/sessions/session-1/ws-ticket",
      { method: "POST", headers: { authorization: "Bearer widget-jwt" } },
    );
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe(
      "wss://api.example.test/api/agent/sessions/session-1/ws?ticket=one-time-ticket",
    );
    expect(FakeWebSocket.instances[0]?.url).not.toContain("widget-jwt");
    client.disconnect();
  });
});
