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

  it("defaults to a fully local deployment", () => {
    const env = loadEnv({});
    expect(env.deploymentMode).toBe("local");
    expect(env.authMode).toBe("local");
    expect(env.storageMode).toBe("sqlite");
    expect(env.objectStorageMode).toBe("filesystem");
  });

  it.each([
    ["DEPLOYMENT_MODE", "saas"], ["DEPLOYMENT_MODE", "enterprise"],
    ["AUTH_MODE", "password"], ["AUTH_MODE", "oidc"], ["EXECUTION_MODE", "remote"],
    ["STORAGE_MODE", "postgres"], ["CONTROL_STORAGE_MODE", "postgres"],
    ["UI_MODE", "saas"], ["OBJECT_STORAGE_MODE", "s3"],
  ])("rejects removed deployment option %s=%s", (key, value) => {
    expect(() => loadEnv({ [key]: value })).toThrow();
  });

  it("keeps local scene storage options", () => {
    const env = loadEnv({ TENANCY_MODE: "multi", STORAGE_MODE: "sqlite-per-tenant" });
    expect(env.tenancyMode).toBe("multi");
    expect(env.storageMode).toBe("sqlite-per-tenant");
  });
});
