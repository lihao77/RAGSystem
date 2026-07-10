import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CircuitOpenError,
  externalCallPolicy,
  ExternalCallTimeoutError,
  OpenAiCompatibleClient,
} from "@ragsystem/agent-llm";

afterEach(() => {
  externalCallPolicy.reset();
  vi.restoreAllMocks();
});

describe("OpenAiCompatibleClient resilience", () => {
  it("retries a transient provider response using provider configuration", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { message: "provider busy" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        choices: [{ message: { content: "done" }, finish_reason: "stop" }],
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));

    const client = new OpenAiCompatibleClient();
    await expect(client.complete({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      provider: {
        key: "retry-provider",
        name: "retry-provider",
        provider_type: "openai_chat",
        api_key: "sk-test",
        api_endpoint: "https://example.test/v1",
        retry_attempts: 1,
        retry_delay: 0,
      },
    })).resolves.toMatchObject({ content: "done", finishReason: "stop" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(externalCallPolicy.snapshot("provider:retry-provider")[0]).toMatchObject({ retries: 1, successes: 1 });
  });

  it("times out when an established stream stops producing bytes", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream<Uint8Array>({
      start() {
        // Intentionally leave the stream open without chunks.
      },
    }), { status: 200, headers: { "content-type": "text/event-stream" } }));

    const client = new OpenAiCompatibleClient();
    await expect(client.stream({
      messages: [{ role: "user", content: "hello" }],
      model: "test-model",
      provider: {
        key: "idle-provider",
        name: "idle-provider",
        provider_type: "openai_chat",
        api_key: "sk-test",
        api_endpoint: "https://example.test/v1",
        timeout: 0.005,
      },
    }, async () => undefined)).rejects.toBeInstanceOf(ExternalCallTimeoutError);
    expect(externalCallPolicy.snapshot("provider:idle-provider")[0]).toMatchObject({
      timeouts: 1,
      failures: 1,
      consecutiveFailures: 1,
    });
  });

  it("opens the provider circuit after consecutive stream idle timeouts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new ReadableStream<Uint8Array>({ start() {} }), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      }));
    const client = new OpenAiCompatibleClient();
    const request = {
      messages: [{ role: "user" as const, content: "hello" }],
      model: "test-model",
      provider: {
        key: "stalled-provider",
        name: "stalled-provider",
        provider_type: "openai_chat",
        api_key: "sk-test",
        api_endpoint: "https://example.test/v1",
        timeout: 0.005,
      },
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.stream(request, async () => undefined)).rejects.toBeInstanceOf(ExternalCallTimeoutError);
    }
    await expect(client.stream(request, async () => undefined)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("opens the provider circuit after consecutive client failures", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(JSON.stringify({ error: { message: "offline" } }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }));
    const client = new OpenAiCompatibleClient();
    const request = {
      messages: [{ role: "user" as const, content: "hello" }],
      model: "test-model",
      provider: {
        key: "offline-provider",
        name: "offline-provider",
        provider_type: "openai_chat",
        api_key: "sk-test",
        api_endpoint: "https://example.test/v1",
      },
    };
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(client.complete(request)).rejects.toThrow("offline");
    }
    await expect(client.complete(request)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
