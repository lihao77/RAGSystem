import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createRagChatClient,
  loginRagSystem,
} from "../src/index.js";

class FakeWebSocket {
  static readonly OPEN = 1;
  readonly readyState = FakeWebSocket.OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string, autoOpen = true) {
    if (autoOpen) queueMicrotask(() => this.open());
  }

  open(): void {
    this.onopen?.();
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.onclose?.();
  }
}

afterEach(() => vi.restoreAllMocks());

describe("loginRagSystem", () => {
  it("uses the auth endpoint and returns the backend session", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      token: "jwt-1",
      expires_at: 123,
      user: { id: "usr_1", displayName: "Demo" },
      tenantId: "tnt_1",
      role: "member",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await loginRagSystem({
      baseUrl: "https://rag.example.test/",
      username: "demo",
      password: "secret",
      fetch: fetchMock,
    });

    expect(result.token).toBe("jwt-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rag.example.test/api/auth/login",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ username: "demo", password: "secret" }) }),
    );
  });
});

describe("RagChatClient", () => {
  it("unifies REST auth and session-scoped WebSocket tickets", async () => {
    const sockets: FakeWebSocket[] = [];
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/agent/sessions") && init?.method === "POST") {
        return new Response(JSON.stringify({ success: true, message: "ok", data: { session_id: "s-1" } }), { status: 200 });
      }
      if (url.endsWith("/api/agent/sessions/s-1/ws-ticket")) {
        return new Response(JSON.stringify({ success: true, message: "ok", data: { ticket: "ticket-1", expires_at: 123 } }), { status: 200 });
      }
      throw new Error(`unexpected request ${url}`);
    });

    const client = createRagChatClient({
      baseUrl: "https://rag.example.test",
      token: "jwt-1",
      fetch: fetchMock,
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    const statuses: unknown[] = [];
    client.on("status", (status) => statuses.push(status));
    const created = await client.createSession();
    expect(created.data.session_id).toBe("s-1");
    await client.connect("s-1");

    expect(sockets).toHaveLength(1);
    expect(sockets[0]?.url).toBe("wss://rag.example.test/api/agent/sessions/s-1/ws?ticket=ticket-1");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "https://rag.example.test/api/agent/sessions/s-1/ws-ticket",
      expect.objectContaining({ headers: { authorization: "Bearer jwt-1" } }),
    );

    expect(statuses.at(-1)).toEqual({ state: "connected", sessionId: "s-1", lastEventSeq: null });
    client.destroy();
  });

  it("supports dynamic credentials for every request", async () => {
    const getToken = vi.fn(async () => "jwt-dynamic");
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true, message: "ok", data: { items: [], next_cursor: null } }), { status: 200 }));
    const client = createRagChatClient({ baseUrl: "https://rag.example.test", getToken, fetch: fetchMock });

    await client.listSessions();

    expect(getToken).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rag.example.test/api/agent/sessions?limit=20",
      expect.objectContaining({ headers: { authorization: "Bearer jwt-dynamic" } }),
    );
  });

  it("binds the native global fetch before invoking it", async () => {
    const originalFetch = globalThis.fetch;
    const calls: unknown[] = [];
    const nativeLikeFetch = function (this: typeof globalThis, input: RequestInfo | URL): Promise<Response> {
      if (this !== globalThis) throw new TypeError("Illegal invocation");
      calls.push(input);
      return Promise.resolve(new Response(JSON.stringify({
        success: true, message: "ok", data: { items: [], next_cursor: null },
      }), { status: 200 }));
    };
    globalThis.fetch = nativeLikeFetch as typeof fetch;
    try {
      const client = createRagChatClient({ baseUrl: "https://rag.example.test" });
      await client.listSessions();
      expect(calls).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not forward the bearer token to cross-origin assets", async () => {
    const fetchMock = vi.fn(async () => new Response("asset", { status: 200 }));
    const client = createRagChatClient({
      baseUrl: "https://rag.example.test",
      token: "jwt-1",
      fetch: fetchMock,
    });

    await client.fetchAsset("https://cdn.example.test/file.txt");
    await client.fetchAsset("https://rag.example.test/api/assets/file.txt");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://cdn.example.test/file.txt",
      expect.objectContaining({ headers: {} }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://rag.example.test/api/assets/file.txt",
      expect.objectContaining({ headers: { authorization: "Bearer jwt-1" } }),
    );

    const customHeaderFetch = vi.fn(async () => new Response("asset", { status: 200 }));
    const customHeaderClient = createRagChatClient({
      baseUrl: "https://rag.example.test",
      headers: { Authorization: "Bearer custom-token" },
      fetch: customHeaderFetch,
    });
    await customHeaderClient.fetchAsset("https://cdn.example.test/file.txt");
    expect(customHeaderFetch).toHaveBeenCalledWith(
      "https://cdn.example.test/file.txt",
      expect.objectContaining({ headers: {} }),
    );
  });

  it("makes concurrent connect calls wait for the same socket", async () => {
    const sockets: FakeWebSocket[] = [];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { ticket: "ticket-1" },
    }), { status: 200 }));
    const client = createRagChatClient({
      baseUrl: "https://rag.example.test",
      fetch: fetchMock,
      createWebSocket: (url) => {
        const socket = new FakeWebSocket(url, false);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
    });

    const first = client.connect("s-1");
    const second = client.connect("s-1");
    let secondSettled = false;
    void second.then(() => { secondSettled = true; });
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    await Promise.resolve();
    expect(secondSettled).toBe(false);

    sockets[0]?.open();
    await Promise.all([first, second]);
    expect(client.isConnected).toBe(true);
    client.disconnect();
  });

  it("preserves and emits disconnected status from the facade", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: { ticket: "ticket-1" },
    }), { status: 200 }));
    const client = createRagChatClient({
      baseUrl: "https://rag.example.test",
      fetch: fetchMock,
      createWebSocket: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });
    const statuses: unknown[] = [];
    client.on("status", (status) => statuses.push(status));

    await client.connect("s-1");
    client.disconnect();

    expect(statuses.at(-1)).toEqual({ state: "disconnected" });
    expect(client.status.get()).toEqual({ state: "disconnected" });
  });

  it("downloads session files through the configured authenticated endpoint", async () => {
    const fetchMock = vi.fn(async () => new Response("file-bytes", {
      status: 200,
      headers: { "content-type": "application/octet-stream" },
    }));
    const client = createRagChatClient({
      baseUrl: "https://rag.example.test",
      token: "jwt-1",
      fetch: fetchMock,
    });

    const response = await client.downloadFile("session/1", "file/1");

    expect(await response.text()).toBe("file-bytes");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://rag.example.test/api/agent/sessions/session%2F1/files/file%2F1/download",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer jwt-1" },
      }),
    );
  });
});
