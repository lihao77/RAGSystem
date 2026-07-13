import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv, resolveDeploymentProfile } from "../../src/config/env.js";

describe("deployment profile", () => {
  it("未配置时使用完整 local 默认值", () => {
    const env = loadEnv({ RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-default") });
    expect(resolveDeploymentProfile(env)).toEqual({
      deployment: "local",
      auth: "local",
      tenancy: "single",
      execution: "local",
      storage: "sqlite",
      ui: "local",
    });
    expect(env.tenantsRoot).toBe(path.join(env.dataRoot, "tenants"));
    expect(env.systemRoot).toBe(path.join(env.dataRoot, "system"));
  });

  it("拒绝 SaaS 使用本地执行", () => {
    expect(() => loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-saas"),
      DEPLOYMENT_MODE: "saas",
      EXECUTION_MODE: "local",
    })).toThrow("危险配置");
  });

  it("显式危险开关允许 SaaS 本地执行", () => {
    const env = loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-saas-unsafe"),
      DEPLOYMENT_MODE: "saas",
      EXECUTION_MODE: "local",
      ALLOW_UNSAFE_LOCAL_EXECUTION: "true",
    });
    expect(resolveDeploymentProfile(env).execution).toBe("local");
  });
});
