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
const UiModeSchema = z.enum(["local", "saas"]);

const EnvSchema = z.object({
  BACKEND_TS_HOST: z.string().optional(),
  BACKEND_TS_PORT: z.string().optional(),
  BACKEND_TS_LOG_LEVEL: z.string().optional(),
  BACKEND_TS_DB_PATH: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  PORT: z.string().optional(),
  RAG_DATA_ROOT: z.string().optional(),
  WIDGET_JWT_SECRET: z.string().optional(),
  SESSION_JWT_SECRET: z.string().optional(),
  SESSION_TOKEN_TTL_HOURS: z.string().optional(),
  DEPLOYMENT_MODE: DeploymentModeSchema.optional(),
  AUTH_MODE: AuthModeSchema.optional(),
  TENANCY_MODE: TenancyModeSchema.optional(),
  EXECUTION_MODE: ExecutionModeSchema.optional(),
  STORAGE_MODE: StorageModeSchema.optional(),
  UI_MODE: UiModeSchema.optional(),
  ALLOW_UNSAFE_LOCAL_EXECUTION: z.string().optional(),
});

export interface AppEnv {
  host: string;
  port: number;
  logLevel: string;
  corsOrigins: string[] | boolean;
  dataRoot: string;
  tenantsRoot: string;
  systemRoot: string;
  dbPath: string;
  deploymentMode?: DeploymentMode | undefined;
  authMode?: AuthMode | undefined;
  tenancyMode?: TenancyMode | undefined;
  executionMode?: ExecutionMode | undefined;
  storageMode?: StorageMode | undefined;
  uiMode?: UiMode | undefined;
  allowUnsafeLocalExecution: boolean;
  /** widget JWT 签名密钥；未设则 widget 鉴权不启用。 */
  widgetJwtSecret?: string | undefined;
  /** 用户 session JWT 签名密钥；password 模式必须可解析。 */
  sessionJwtSecret?: string | undefined;
  sessionTokenTtlHours?: number | undefined;
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
  const dbPath = env.BACKEND_TS_DB_PATH?.trim() || path.join(dataRoot, "db", "ragsystem.db");

  const appEnv: AppEnv = {
    host: env.BACKEND_TS_HOST ?? "0.0.0.0",
    port,
    logLevel: env.BACKEND_TS_LOG_LEVEL ?? "info",
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    dataRoot,
    tenantsRoot: path.join(dataRoot, "tenants"),
    systemRoot: path.join(dataRoot, "system"),
    dbPath: path.resolve(dbPath),
    deploymentMode: env.DEPLOYMENT_MODE,
    authMode: env.AUTH_MODE,
    tenancyMode: env.TENANCY_MODE,
    executionMode: env.EXECUTION_MODE,
    storageMode: env.STORAGE_MODE,
    uiMode: env.UI_MODE,
    allowUnsafeLocalExecution: parseBooleanFlag(env.ALLOW_UNSAFE_LOCAL_EXECUTION),
    widgetJwtSecret: env.WIDGET_JWT_SECRET?.trim() || undefined,
    sessionJwtSecret: env.SESSION_JWT_SECRET?.trim() || undefined,
    sessionTokenTtlHours: parsePositiveNumber(env.SESSION_TOKEN_TTL_HOURS, 168, "SESSION_TOKEN_TTL_HOURS"),
  };
  resolveDeploymentProfile(appEnv);
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

function validateDeploymentProfile(profile: DeploymentProfile, allowUnsafeLocalExecution: boolean): void {
  if (profile.deployment === "saas" && profile.execution === "local" && !allowUnsafeLocalExecution) {
    throw new Error(
      "危险配置: DEPLOYMENT_MODE=saas 禁止使用 EXECUTION_MODE=local。仅在明确接受宿主机执行风险时设置 ALLOW_UNSAFE_LOCAL_EXECUTION=true。",
    );
  }
}
