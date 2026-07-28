import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import type {
  AuthMode,
  DeploymentMode,
  DeploymentProfile,
  ExecutionMode,
  StorageMode,
  TenancyMode,
  UiMode,
} from "../identity/types.js";

const DeploymentModeSchema = z.enum(["local", "saas", "enterprise"]);
const AuthModeSchema = z.enum(["local", "password", "oidc"]);
const TenancyModeSchema = z.enum(["single", "multi"]);
const ExecutionModeSchema = z.enum(["local", "docker", "remote"]);
const StorageModeSchema = z.enum(["sqlite", "sqlite-per-tenant", "postgres"]);
const ControlStorageModeSchema = z.enum(["sqlite", "postgres"]);
const UiModeSchema = z.enum(["local", "saas"]);
const ObjectStorageModeSchema = z.enum(["filesystem", "s3"]);

const EnvSchema = z.object({
  BACKEND_TS_HOST: z.string().optional(),
  BACKEND_TS_PORT: z.string().optional(),
  BACKEND_TS_LOG_LEVEL: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  PORT: z.string().optional(),
  RAG_DATA_ROOT: z.string().optional(),
  SESSION_JWT_SECRET: z.string().optional(),
  SESSION_TOKEN_TTL_HOURS: z.string().optional(),
  DEPLOYMENT_MODE: DeploymentModeSchema.optional(),
  AUTH_MODE: AuthModeSchema.optional(),
  TENANCY_MODE: TenancyModeSchema.optional(),
  EXECUTION_MODE: ExecutionModeSchema.optional(),
  STORAGE_MODE: StorageModeSchema.optional(),
  CONTROL_STORAGE_MODE: ControlStorageModeSchema.optional(),
  UI_MODE: UiModeSchema.optional(),
  ALLOW_UNSAFE_LOCAL_EXECUTION: z.string().optional(),
  DATABASE_URL: z.string().optional(),
  POSTGRES_POOL_MAX: z.string().optional(),
  CONTROL_DATABASE_URL: z.string().optional(),
  CONTROL_SECRET_MASTER_KEY: z.string().optional(),
  OBJECT_STORAGE_MODE: ObjectStorageModeSchema.optional(),
  OBJECT_STORAGE_BUCKET: z.string().optional(),
  OBJECT_STORAGE_ENDPOINT: z.string().optional(),
  OBJECT_STORAGE_ACCESS_KEY_ID: z.string().optional(),
  OBJECT_STORAGE_SECRET_ACCESS_KEY: z.string().optional(),
  OBJECT_STORAGE_REGION: z.string().optional(),
  OBJECT_STORAGE_FORCE_PATH_STYLE: z.string().optional(),
  SANDBOX_REMOTE_URL: z.string().optional(),
  SANDBOX_REMOTE_TOKEN: z.string().optional(),
  SANDBOX_REQUEST_TIMEOUT_MS: z.string().optional(),
  SANDBOX_LEASE_TIMEOUT_SECONDS: z.string().optional(),
  SANDBOX_ALLOW_INSECURE_HTTP: z.string().optional(),
});

export interface AppEnv {
  host: string;
  port: number;
  logLevel: string;
  corsOrigins: string[] | boolean;
  dataRoot: string;
  tenantsRoot: string;
  systemRoot: string;
  deploymentMode?: DeploymentMode | undefined;
  authMode?: AuthMode | undefined;
  tenancyMode?: TenancyMode | undefined;
  executionMode?: ExecutionMode | undefined;
  storageMode?: StorageMode | undefined;
  controlStorageMode?: "sqlite" | "postgres" | undefined;
  uiMode?: UiMode | undefined;
  allowUnsafeLocalExecution: boolean;
  databaseUrl?: string | undefined;
  controlDatabaseUrl?: string | undefined;
  controlSecretMasterKey?: Buffer | undefined;
  postgresPoolMax: number;
  /** Blob storage selected by the composition root. SaaS must use s3. */
  objectStorageMode: "filesystem" | "s3";
  objectStorageBucket?: string | undefined;
  objectStorageEndpoint?: string | undefined;
  objectStorageAccessKeyId?: string | undefined;
  objectStorageSecretAccessKey?: string | undefined;
  objectStorageRegion: string;
  objectStorageForcePathStyle: boolean;
  /** 用户 session JWT 签名密钥；password 模式必须可解析。 */
  sessionJwtSecret?: string | undefined;
  sessionTokenTtlHours?: number | undefined;
  sandboxRemoteUrl?: string | undefined;
  sandboxRemoteToken?: string | undefined;
  sandboxRequestTimeoutMs?: number | undefined;
  sandboxLeaseTimeoutSeconds?: number | undefined;
  sandboxAllowInsecureHttp: boolean;
}

export function loadEnv(source: NodeJS.ProcessEnv): AppEnv {
  // 读 cwd/.env 补充（Node 不像 vite 自动读 .env；真实 env 优先，不覆盖已存在的）。
  const merged: Record<string, string> = {};
  const dotEnvPath = path.resolve(process.cwd(), ".env");
  if (existsSync(dotEnvPath)) {
    for (const raw of readFileSync(dotEnvPath, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
      if (key) merged[key] = value;
    }
  }
  Object.assign(merged, source);
  const env = EnvSchema.parse(merged);
  const rawPort = env.BACKEND_TS_PORT ?? env.PORT ?? "5002";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid BACKEND_TS_PORT/PORT: ${rawPort}`);
  }

  const dataRoot = path.resolve(env.RAG_DATA_ROOT?.trim() || path.join(os.homedir(), ".ragsystem"));
  const isSaaS = env.DEPLOYMENT_MODE === "saas";

  const appEnv: AppEnv = {
    host: env.BACKEND_TS_HOST ?? "0.0.0.0",
    port,
    logLevel: env.BACKEND_TS_LOG_LEVEL ?? "info",
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    dataRoot,
    tenantsRoot: path.join(dataRoot, "tenants"),
    systemRoot: path.join(dataRoot, "system"),
    deploymentMode: env.DEPLOYMENT_MODE,
    authMode: env.AUTH_MODE,
    tenancyMode: env.TENANCY_MODE,
    executionMode: env.EXECUTION_MODE,
    storageMode: env.STORAGE_MODE ?? (isSaaS ? "postgres" : "sqlite"),
    controlStorageMode: env.CONTROL_STORAGE_MODE ?? (isSaaS ? "postgres" : "sqlite"),
    uiMode: env.UI_MODE,
    allowUnsafeLocalExecution: parseBooleanFlag(env.ALLOW_UNSAFE_LOCAL_EXECUTION),
    databaseUrl: env.DATABASE_URL?.trim() || undefined,
    controlDatabaseUrl: env.CONTROL_DATABASE_URL?.trim() || undefined,
    controlSecretMasterKey: parseSecretMasterKey(env.CONTROL_SECRET_MASTER_KEY),
    postgresPoolMax: parsePositiveInteger(env.POSTGRES_POOL_MAX, 10, "POSTGRES_POOL_MAX"),
    objectStorageMode: env.OBJECT_STORAGE_MODE ?? (isSaaS ? "s3" : "filesystem"),
    objectStorageBucket: env.OBJECT_STORAGE_BUCKET?.trim() || undefined,
    objectStorageEndpoint: env.OBJECT_STORAGE_ENDPOINT?.trim() || undefined,
    objectStorageAccessKeyId: env.OBJECT_STORAGE_ACCESS_KEY_ID?.trim() || undefined,
    objectStorageSecretAccessKey: env.OBJECT_STORAGE_SECRET_ACCESS_KEY?.trim() || undefined,
    objectStorageRegion: env.OBJECT_STORAGE_REGION?.trim() || "us-east-1",
    objectStorageForcePathStyle: env.OBJECT_STORAGE_FORCE_PATH_STYLE === undefined ? true : parseBooleanFlag(env.OBJECT_STORAGE_FORCE_PATH_STYLE),
    sessionJwtSecret: env.SESSION_JWT_SECRET?.trim() || undefined,
    sessionTokenTtlHours: parsePositiveNumber(env.SESSION_TOKEN_TTL_HOURS, 168, "SESSION_TOKEN_TTL_HOURS"),
    sandboxRemoteUrl: env.SANDBOX_REMOTE_URL?.trim() || undefined,
    sandboxRemoteToken: env.SANDBOX_REMOTE_TOKEN?.trim() || undefined,
    sandboxRequestTimeoutMs: parsePositiveInteger(env.SANDBOX_REQUEST_TIMEOUT_MS, 30_000, "SANDBOX_REQUEST_TIMEOUT_MS"),
    sandboxLeaseTimeoutSeconds: parsePositiveInteger(env.SANDBOX_LEASE_TIMEOUT_SECONDS, 900, "SANDBOX_LEASE_TIMEOUT_SECONDS"),
    sandboxAllowInsecureHttp: parseBooleanFlag(env.SANDBOX_ALLOW_INSECURE_HTTP),
  };
  if (Boolean(appEnv.sandboxRemoteUrl) !== Boolean(appEnv.sandboxRemoteToken)) {
    throw new Error("SANDBOX_REMOTE_URL and SANDBOX_REMOTE_TOKEN must be configured together");
  }
  if (isSaaS && appEnv.storageMode !== "postgres") {
    throw new Error("DEPLOYMENT_MODE=saas requires STORAGE_MODE=postgres; SQLite runtime storage is not allowed");
  }
  if (isSaaS && appEnv.controlStorageMode !== "postgres") {
    throw new Error("DEPLOYMENT_MODE=saas requires CONTROL_STORAGE_MODE=postgres; SQLite control storage is not allowed");
  }
  resolveDeploymentProfile(appEnv);
  if (appEnv.storageMode === "postgres" && !appEnv.databaseUrl) {
    throw new Error("STORAGE_MODE=postgres requires DATABASE_URL");
  }
  if (appEnv.controlStorageMode === "postgres" && !appEnv.controlDatabaseUrl) {
    throw new Error("CONTROL_STORAGE_MODE=postgres requires CONTROL_DATABASE_URL");
  }
  if (appEnv.controlStorageMode === "postgres" && !appEnv.controlSecretMasterKey) {
    throw new Error("CONTROL_STORAGE_MODE=postgres requires CONTROL_SECRET_MASTER_KEY (base64 encoded 32-byte key)");
  }
  if (appEnv.storageMode === "postgres") {
    if (appEnv.objectStorageMode !== "s3") {
      throw new Error("STORAGE_MODE=postgres requires OBJECT_STORAGE_MODE=s3");
    }
    if (!appEnv.objectStorageBucket) {
      throw new Error("OBJECT_STORAGE_MODE=s3 requires OBJECT_STORAGE_BUCKET");
    }
    if (!appEnv.objectStorageEndpoint || !appEnv.objectStorageAccessKeyId || !appEnv.objectStorageSecretAccessKey) {
      throw new Error("OBJECT_STORAGE_MODE=s3 requires OBJECT_STORAGE_ENDPOINT, OBJECT_STORAGE_ACCESS_KEY_ID and OBJECT_STORAGE_SECRET_ACCESS_KEY");
    }
  }
  return appEnv;
}

export function resolveDeploymentProfile(env: AppEnv): DeploymentProfile {
  const profile = seedDeploymentProfile(env);
  validateDeploymentProfile(profile, env.allowUnsafeLocalExecution);
  return profile;
}

export function resolveProfileFromSettings(settings: Record<string, string>, env: AppEnv): DeploymentProfile {
  const seeded = seedDeploymentProfile(env);
  const profile: DeploymentProfile = {
    deployment: DeploymentModeSchema.parse(settings.deployment_mode ?? seeded.deployment),
    auth: AuthModeSchema.parse(settings.auth_mode ?? seeded.auth),
    tenancy: TenancyModeSchema.parse(settings.tenancy_mode ?? seeded.tenancy),
    execution: ExecutionModeSchema.parse(settings.execution_mode ?? seeded.execution),
    storage: StorageModeSchema.parse(settings.storage_mode ?? seeded.storage),
    ui: UiModeSchema.parse(settings.ui_mode ?? seeded.ui),
  };
  validateDeploymentProfile(profile, env.allowUnsafeLocalExecution);
  return profile;
}

function seedDeploymentProfile(env: AppEnv): DeploymentProfile {
  return {
    deployment: env.deploymentMode ?? "local",
    auth: env.authMode ?? "local",
    tenancy: env.tenancyMode ?? "single",
    execution: env.executionMode ?? "local",
    storage: env.storageMode ?? "sqlite",
    ui: env.uiMode ?? "local",
  };
}

function parseCorsOrigins(rawValue: string | undefined): string[] | boolean {
  if (!rawValue?.trim()) {
    return true;
  }
  return rawValue
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBooleanFlag(rawValue: string | undefined): boolean {
  return rawValue?.trim().toLowerCase() === "true";
}

function parsePositiveNumber(rawValue: string | undefined, fallback: number, name: string): number {
  if (!rawValue?.trim()) return fallback;
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} 必须为正数`);
  return value;
}

function parsePositiveInteger(rawValue: string | undefined, fallback: number, name: string): number {
  const value = parsePositiveNumber(rawValue, fallback, name);
  if (!Number.isInteger(value)) throw new Error(`${name} 必须为正整数`);
  return value;
}

function parseSecretMasterKey(rawValue: string | undefined): Buffer | undefined {
  if (!rawValue?.trim()) return undefined;
  const normalized = rawValue.trim();
  const key = Buffer.from(normalized, "base64");
  if (key.length !== 32 || key.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")) {
    throw new Error("CONTROL_SECRET_MASTER_KEY must be a valid base64 encoded 32-byte key");
  }
  return key;
}

function validateDeploymentProfile(profile: DeploymentProfile, allowUnsafeLocalExecution: boolean): void {
  if (profile.deployment === "saas" && profile.execution === "local" && !allowUnsafeLocalExecution) {
    throw new Error(
      "危险配置: DEPLOYMENT_MODE=saas 禁止使用 EXECUTION_MODE=local。仅在明确接受宿主机执行风险时设置 ALLOW_UNSAFE_LOCAL_EXECUTION=true。",
    );
  }
}
