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

  it("loads PostgreSQL pool settings and prefers DATABASE_URL", () => {
    const env = loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-postgres"),
      DATABASE_URL: "postgres://primary/database",
      POSTGRES_URL: "postgres://alias/database",
      POSTGRES_POOL_MAX: "24",
    });
    expect(env.databaseUrl).toBe("postgres://primary/database");
    expect(env.postgresPoolMax).toBe(24);
  });

  it("accepts POSTGRES_URL as an alias and validates pool size", () => {
    const env = loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-postgres-alias"),
      POSTGRES_URL: "postgres://alias/database",
    });
    expect(env.databaseUrl).toBe("postgres://alias/database");
    expect(env.postgresPoolMax).toBe(10);
    expect(() => loadEnv({ POSTGRES_POOL_MAX: "1.5" })).toThrow("POSTGRES_POOL_MAX");
  });

  it("requires a database URL when PostgreSQL storage is selected", () => {
    expect(() => loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-postgres-required"),
      STORAGE_MODE: "postgres",
    })).toThrow("STORAGE_MODE=postgres requires DATABASE_URL");
  });
});
