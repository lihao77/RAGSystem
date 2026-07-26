import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadEnv, resolveDeploymentProfile } from "../../src/config/env.js";

const validSaaSStorage = {
  DATABASE_URL: "postgres://runtime/database",
  CONTROL_DATABASE_URL: "postgres://control/database",
  CONTROL_SECRET_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
  OBJECT_STORAGE_BUCKET: "ragsystem",
  OBJECT_STORAGE_ENDPOINT: "http://object-storage:9000",
  OBJECT_STORAGE_ACCESS_KEY_ID: "access-key",
  OBJECT_STORAGE_SECRET_ACCESS_KEY: "secret-key",
};

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
    expect(env.controlStorageMode).toBe("sqlite");
    expect(env.controlDatabaseUrl).toBeUndefined();
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
      ...validSaaSStorage,
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-saas-unsafe"),
      DEPLOYMENT_MODE: "saas",
      EXECUTION_MODE: "local",
      ALLOW_UNSAFE_LOCAL_EXECUTION: "true",
    });
    expect(resolveDeploymentProfile(env).execution).toBe("local");
  });

  it("SaaS 默认使用 PostgreSQL 与对象存储", () => {
    const env = loadEnv({
      ...validSaaSStorage,
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-saas-storage-defaults"),
      DEPLOYMENT_MODE: "saas",
      EXECUTION_MODE: "remote",
    });
    expect(env.storageMode).toBe("postgres");
    expect(env.controlStorageMode).toBe("postgres");
    expect(env.objectStorageMode).toBe("s3");
  });

  it("拒绝 SaaS 显式回退到 SQLite", () => {
    for (const storageMode of ["sqlite", "sqlite-per-tenant"] as const) {
      expect(() => loadEnv({
        ...validSaaSStorage,
        RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", `env-saas-${storageMode}`),
        DEPLOYMENT_MODE: "saas",
        EXECUTION_MODE: "remote",
        STORAGE_MODE: storageMode,
      })).toThrow("SQLite runtime storage is not allowed");
    }
    expect(() => loadEnv({
      ...validSaaSStorage,
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-saas-control-sqlite"),
      DEPLOYMENT_MODE: "saas",
      EXECUTION_MODE: "remote",
      CONTROL_STORAGE_MODE: "sqlite",
    })).toThrow("SQLite control storage is not allowed");
  });

  it("SaaS 默认 PostgreSQL 时要求连接配置", () => {
    expect(() => loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-saas-postgres-required"),
      DEPLOYMENT_MODE: "saas",
      EXECUTION_MODE: "remote",
    })).toThrow("STORAGE_MODE=postgres requires DATABASE_URL");
  });

  it("loads PostgreSQL pool settings and prefers DATABASE_URL", () => {
    const env = loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-postgres"),
      DATABASE_URL: "postgres://primary/database",
      POSTGRES_POOL_MAX: "24",
    });
    expect(env.databaseUrl).toBe("postgres://primary/database");
    expect(env.postgresPoolMax).toBe(24);
  });

  it("validates pool size", () => {
    const env = loadEnv({ RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-postgres-pool") });
    expect(() => loadEnv({ POSTGRES_POOL_MAX: "1.5" })).toThrow("POSTGRES_POOL_MAX");
  });

  it("loads sandbox provider settings and requires URL/token together", () => {
    const env = loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-sandbox"),
      SANDBOX_REMOTE_URL: "https://sandbox.example",
      SANDBOX_REMOTE_TOKEN: "secret",
      SANDBOX_REQUEST_TIMEOUT_MS: "45000",
      SANDBOX_LEASE_TIMEOUT_SECONDS: "600",
    });
    expect(env).toMatchObject({
      sandboxRemoteUrl: "https://sandbox.example",
      sandboxRemoteToken: "secret",
      sandboxRequestTimeoutMs: 45_000,
      sandboxLeaseTimeoutSeconds: 600,
    });
    expect(() => loadEnv({ SANDBOX_REMOTE_URL: "https://sandbox.example" })).toThrow("configured together");
    expect(() => loadEnv({ SANDBOX_REMOTE_TOKEN: "secret" })).toThrow("configured together");
  });

  it("requires a database URL when PostgreSQL storage is selected", () => {
    expect(() => loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-postgres-required"),
      STORAGE_MODE: "postgres",
    })).toThrow("STORAGE_MODE=postgres requires DATABASE_URL");
  });

  it("keeps PostgreSQL Control Plane configuration independent from Memory", () => {
    const env = loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-control-postgres"),
      DATABASE_URL: "postgres://memory/database",
      CONTROL_STORAGE_MODE: "postgres",
      CONTROL_DATABASE_URL: "postgres://control/database",
      CONTROL_SECRET_MASTER_KEY: Buffer.alloc(32, 1).toString("base64"),
    });
    expect(env.databaseUrl).toBe("postgres://memory/database");
    expect(env.controlStorageMode).toBe("postgres");
    expect(env.controlDatabaseUrl).toBe("postgres://control/database");
    expect(env.controlSecretMasterKey).toEqual(Buffer.alloc(32, 1));
  });

  it("requires the independent Control Plane URL in PostgreSQL mode", () => {
    expect(() => loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-control-postgres-required"),
      DATABASE_URL: "postgres://memory/database",
      CONTROL_STORAGE_MODE: "postgres",
    })).toThrow("CONTROL_STORAGE_MODE=postgres requires CONTROL_DATABASE_URL");
  });

  it("requires an independent 32-byte Control secret key in PostgreSQL mode", () => {
    expect(() => loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-control-secret-required"),
      CONTROL_STORAGE_MODE: "postgres",
      CONTROL_DATABASE_URL: "postgres://control/database",
    })).toThrow("CONTROL_STORAGE_MODE=postgres requires CONTROL_SECRET_MASTER_KEY");
  });

  it("parses a shared Widget JWT key ring and rejects an expired active key", () => {
    const env = loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-widget-key-ring"),
      WIDGET_JWT_KEY_RING: JSON.stringify({
        active: { kid: "v2", secret: "a".repeat(32) },
        previous: [{ kid: "v1", secret: "b".repeat(32), expiresAt: 4_102_444_800 }],
      }),
    });
    expect(env.widgetJwtKeyRing?.readiness()).toMatchObject({ ready: true, activeKid: "v2", verificationKids: ["v1", "v2"] });
    expect(() => loadEnv({
      RAG_DATA_ROOT: path.join(process.cwd(), ".test-data", "env-widget-key-ring-expired"),
      WIDGET_JWT_KEY_RING: JSON.stringify({ active: { kid: "expired", secret: "a".repeat(32), expiresAt: 1 } }),
    })).toThrow("WIDGET_JWT_KEY_RING is not ready");
  });
});
