import { describe, expect, it } from "vitest";

import { loadConfig } from "../src/config.js";

describe("sandbox service config", () => {
  it("uses secure bounded defaults", () => {
    expect(loadConfig({ SANDBOX_API_TOKEN: "x".repeat(32) })).toMatchObject({
      host: "0.0.0.0",
      port: 5003,
      runtimeImage: "ragsystem-sandbox-runtime:local",
      dockerRuntime: null,
      memory: "1g",
      cpus: "1",
      pidsLimit: 128,
      maxActiveLeases: 8,
    });
  });

  it("rejects missing or weak service tokens and invalid numeric limits", () => {
    expect(() => loadConfig({})).toThrow("SANDBOX_API_TOKEN");
    expect(() => loadConfig({ SANDBOX_API_TOKEN: "short" })).toThrow("at least 24");
    expect(() => loadConfig({ SANDBOX_API_TOKEN: "x".repeat(32), SANDBOX_PIDS_LIMIT: "0" })).toThrow("positive integer");
    expect(() => loadConfig({ SANDBOX_API_TOKEN: "x".repeat(32), SANDBOX_MAX_ACTIVE_LEASES: "0" })).toThrow("positive integer");
  });
});
