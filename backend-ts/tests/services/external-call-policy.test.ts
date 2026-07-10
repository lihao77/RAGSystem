import { describe, expect, it } from "vitest";

import {
  CircuitOpenError,
  ExternalCallPolicyRegistry,
  ExternalCallTimeoutError,
  RetryableHttpError,
} from "@ragsystem/agent-llm";

describe("ExternalCallPolicyRegistry", () => {
  it("retries transient failures and records one logical success", async () => {
    const registry = new ExternalCallPolicyRegistry();
    let attempts = 0;
    const result = await registry.execute({
      key: "provider:test",
      maxAttempts: 3,
      baseDelayMs: 0,
      jitterRatio: 0,
      operation: async () => {
        attempts += 1;
        if (attempts < 3) throw new RetryableHttpError(503);
        return "ok";
      },
    });

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
    expect(registry.snapshot("provider:test")[0]).toMatchObject({
      state: "closed",
      calls: 1,
      successes: 1,
      failures: 0,
      retries: 2,
    });
  });

  it("does not retry non-transient failures", async () => {
    const registry = new ExternalCallPolicyRegistry();
    let attempts = 0;
    await expect(registry.execute({
      key: "provider:bad-request",
      maxAttempts: 3,
      operation: async () => {
        attempts += 1;
        throw new Error("invalid request");
      },
    })).rejects.toThrow("invalid request");
    expect(attempts).toBe(1);
  });

  it("opens, rejects, and recovers through a half-open probe", async () => {
    const registry = new ExternalCallPolicyRegistry();
    const failingCall = () => registry.execute({
      key: "mcp:demo",
      failureThreshold: 1,
      resetTimeoutMs: 5,
      operation: async () => { throw new Error("offline"); },
    });
    await expect(failingCall()).rejects.toThrow("offline");
    await expect(failingCall()).rejects.toBeInstanceOf(CircuitOpenError);

    await new Promise((resolve) => setTimeout(resolve, 10));
    let releaseProbe!: () => void;
    const probeGate = new Promise<void>((resolve) => { releaseProbe = resolve; });
    const probe = registry.execute({
      key: "mcp:demo",
      operation: async () => {
        await probeGate;
        return "healthy";
      },
    });
    await Promise.resolve();
    await expect(registry.execute({
      key: "mcp:demo",
      operation: async () => "unexpected",
    })).rejects.toBeInstanceOf(CircuitOpenError);
    releaseProbe();
    await expect(probe).resolves.toBe("healthy");
    expect(registry.snapshot("mcp:demo")[0]).toMatchObject({ state: "closed", consecutiveFailures: 0 });
  });

  it("aborts a cooperative operation at the per-attempt timeout", async () => {
    const registry = new ExternalCallPolicyRegistry();
    await expect(registry.execute({
      key: "provider:slow",
      timeoutMs: 5,
      operation: ({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      }),
    })).rejects.toBeInstanceOf(ExternalCallTimeoutError);
    expect(registry.snapshot("provider:slow")[0]).toMatchObject({ timeouts: 1, failures: 1 });
  });

  it("records failures that occur after the guarded operation returns", () => {
    const registry = new ExternalCallPolicyRegistry();
    registry.recordFailure("provider:stream", new ExternalCallTimeoutError(10), { failureThreshold: 1 });
    expect(registry.snapshot("provider:stream")[0]).toMatchObject({
      state: "open",
      failures: 1,
      timeouts: 1,
      consecutiveFailures: 1,
    });
  });

  it("reopens a half-open deferred probe when the caller aborts it", async () => {
    const registry = new ExternalCallPolicyRegistry();
    registry.recordFailure("provider:probe", new Error("offline"), {
      failureThreshold: 1,
      resetTimeoutMs: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    await registry.execute({
      key: "provider:probe",
      deferSuccess: true,
      operation: async () => "stream",
    });
    registry.recordAbort("provider:probe");
    expect(registry.snapshot("provider:probe")[0]).toMatchObject({
      state: "open",
      failures: 1,
      successes: 0,
    });
  });
});
