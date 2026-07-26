import { afterEach, describe, expect, it, vi } from "vitest";

import { RemoteHttpSandboxProvider, SandboxProviderHttpError } from "../../../../src/adapters/saas/sandbox/http-sandbox-provider.js";

describe("RemoteHttpSandboxProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends bearer authentication without exposing it in the lease", async () => {
    const owner = { tenantId: "tenant-a" as never, userId: "user-a", sessionId: "session-a", runId: "run-a" };
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ id: "provider-id", owner }), { status: 201, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new RemoteHttpSandboxProvider({ baseUrl: "https://sandbox.example", token: "top-secret" });
    const lease = await provider.create({ owner, network: "none", timeoutSeconds: 30, filesystem: { input: "read_only", work: "read_write", output: "read_write" } });

    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer top-secret");
    expect(JSON.stringify(lease)).not.toContain("top-secret");
    expect(lease.id).toBe("provider-id");
  });

  it("returns typed provider errors without including the bearer token", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "quota", message: "quota exceeded" }), { status: 429 })));
    const provider = new RemoteHttpSandboxProvider({ baseUrl: "https://sandbox.example", token: "top-secret" });
    const owner = { tenantId: "tenant-a" as never, userId: "user-a", sessionId: "session-a", runId: "run-a" };
    await expect(provider.create({ owner, network: "none", timeoutSeconds: 30, filesystem: { input: "read_only", work: "read_write", output: "read_write" } })).rejects.toMatchObject({
      status: 429, code: "quota", message: "quota exceeded",
    } satisfies Partial<SandboxProviderHttpError>);
  });

  it("rejects a sandbox response owned by another isolation scope", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      id: "provider-id",
      owner: { tenantId: "tenant-b", userId: "user-a", sessionId: "session-a", runId: "run-a" },
    }), { status: 201 })));
    const provider = new RemoteHttpSandboxProvider({ baseUrl: "https://sandbox.example", token: "top-secret" });
    const owner = { tenantId: "tenant-a" as never, userId: "user-a", sessionId: "session-a", runId: "run-a" };

    await expect(provider.create({ owner, network: "none", timeoutSeconds: 30, filesystem: { input: "read_only", work: "read_write", output: "read_write" } }))
      .rejects.toThrow("owner mismatch");
  });

  it("uses a privileged staging endpoint and forwards provider-enforced read limits", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ size: 5 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: "aGVsbG8=", size: 5 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const provider = new RemoteHttpSandboxProvider({ baseUrl: "https://sandbox.example", token: "top-secret" });
    const scopedLease = {
      id: "provider-id",
      owner: { tenantId: "tenant-a" as never, userId: "user-a", sessionId: "session-a", runId: "run-a" },
      createdAt: "2026-07-26T00:00:00.000Z",
    };

    await provider.stageInputFile(scopedLease, {
      path: "/input/uploads/a.txt", content: "aGVsbG8=", encoding: "base64", contentType: "text/plain",
    });
    await provider.readFile(scopedLease, {
      path: "/output/a.txt", encoding: "base64", maxBytes: 1024,
    });

    expect(String(fetchMock.mock.calls[0]![0])).toContain("/files/stage-input");
    expect(JSON.parse(String(fetchMock.mock.calls[1]![1]?.body))).toMatchObject({ maxBytes: 1024 });
  });

  it("forbids cleartext remote endpoints but permits local development HTTP", () => {
    expect(() => new RemoteHttpSandboxProvider({ baseUrl: "http://sandbox.internal", token: "x" })).toThrow("HTTPS");
    expect(() => new RemoteHttpSandboxProvider({ baseUrl: "http://127.0.0.1:8080", token: "x" })).not.toThrow();
    expect(() => new RemoteHttpSandboxProvider({ baseUrl: "http://[::1]:8080", token: "x" })).not.toThrow();
  });

  it("rejects ambiguous endpoint configuration", () => {
    expect(() => new RemoteHttpSandboxProvider({ baseUrl: "https://user:pass@sandbox.example", token: "x" })).toThrow("credentials");
    expect(() => new RemoteHttpSandboxProvider({ baseUrl: "https://sandbox.example?route=other", token: "x" })).toThrow("query");
    expect(() => new RemoteHttpSandboxProvider({ baseUrl: "https://sandbox.example", token: "x", requestTimeoutMs: 0 })).toThrow("positive integer");
  });
});
