import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadEnv, loadEnvSource } from "../src/config/env.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("environment loading", () => {
  it("reads the explicit launch directory and lets process values override .env defaults", () => {
    const launchDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-env-"));
    temporaryDirectories.push(launchDirectory);
    fs.writeFileSync(
      path.join(launchDirectory, ".env"),
      "SESSION_JWT_SECRET=from-launch-directory\nBACKEND_TS_PORT=5003\n",
      "utf8",
    );

    const source = loadEnvSource({ BACKEND_TS_PORT: "5004" }, launchDirectory);

    expect(source.SESSION_JWT_SECRET).toBe("from-launch-directory");
    expect(source.BACKEND_TS_PORT).toBe("5004");
  });

  it("ignores an unpaired remote sandbox token for local execution", () => {
    const env = loadEnv({ EXECUTION_MODE: "local", SANDBOX_REMOTE_TOKEN: "unused-token" });

    expect(env.executionMode).toBe("local");
    expect(env.sandboxRemoteToken).toBe("unused-token");
  });

  it("rejects unpaired remote sandbox credentials for remote execution", () => {
    expect(() => loadEnv({
      EXECUTION_MODE: "remote",
      SANDBOX_REMOTE_TOKEN: "missing-url",
    })).toThrow("EXECUTION_MODE=remote requires SANDBOX_REMOTE_URL and SANDBOX_REMOTE_TOKEN");
  });

  it("rejects remote execution without a sandbox endpoint", () => {
    expect(() => loadEnv({
      EXECUTION_MODE: "remote",
    })).toThrow("EXECUTION_MODE=remote requires SANDBOX_REMOTE_URL and SANDBOX_REMOTE_TOKEN");
  });
});
