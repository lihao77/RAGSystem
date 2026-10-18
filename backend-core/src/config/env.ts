import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import os from "node:os";
import path from "node:path";
import type { DeploymentProfile } from "../identity/types.js";

const EnvSchema = z.object({
  BACKEND_TS_HOST: z.string().optional(),
  BACKEND_TS_PORT: z.string().optional(),
  BACKEND_TS_LOG_LEVEL: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  PORT: z.string().optional(),
  RAG_DATA_ROOT: z.string().optional(),
  DEPLOYMENT_MODE: z.literal("local").optional(),
  AUTH_MODE: z.literal("local").optional(),
  TENANCY_MODE: z.enum(["single", "multi"]).optional(),
  EXECUTION_MODE: z.literal("local").optional(),
  STORAGE_MODE: z.enum(["sqlite", "sqlite-per-tenant"]).optional(),
  CONTROL_STORAGE_MODE: z.literal("sqlite").optional(),
  UI_MODE: z.literal("local").optional(),
  OBJECT_STORAGE_MODE: z.literal("filesystem").optional(),
});

export interface AppEnv {
  host: string;
  port: number;
  logLevel: string;
  corsOrigins: string[] | boolean;
  dataRoot: string;
  tenantsRoot: string;
  systemRoot: string;
  deploymentMode?: "local" | undefined;
  authMode?: "local" | undefined;
  tenancyMode?: "single" | "multi" | undefined;
  executionMode?: "local" | undefined;
  storageMode?: "sqlite" | "sqlite-per-tenant" | undefined;
  controlStorageMode?: "sqlite" | undefined;
  uiMode?: "local" | undefined;
  objectStorageMode: "filesystem";
}

/** Reads cwd/.env as defaults while preserving values supplied by the process environment. */
export function loadEnvSource(
  source: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): NodeJS.ProcessEnv {
  const merged: Record<string, string> = {};
  const dotEnvPath = path.resolve(cwd, ".env");
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
  return merged;
}

export function loadEnv(source: NodeJS.ProcessEnv): AppEnv {
  const env = EnvSchema.parse(loadEnvSource(source));
  const rawPort = env.BACKEND_TS_PORT ?? env.PORT ?? "5002";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid BACKEND_TS_PORT/PORT: ${rawPort}`);
  }
  const dataRoot = path.resolve(env.RAG_DATA_ROOT?.trim() || path.join(os.homedir(), ".ragsystem"));
  return {
    host: env.BACKEND_TS_HOST ?? "0.0.0.0",
    port,
    logLevel: env.BACKEND_TS_LOG_LEVEL ?? "info",
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    dataRoot,
    tenantsRoot: path.join(dataRoot, "tenants"),
    systemRoot: path.join(dataRoot, "system"),
    deploymentMode: "local",
    authMode: "local",
    tenancyMode: env.TENANCY_MODE ?? "single",
    executionMode: "local",
    storageMode: env.STORAGE_MODE ?? "sqlite",
    controlStorageMode: "sqlite",
    uiMode: "local",
    objectStorageMode: "filesystem",
  };
}

export function resolveDeploymentProfile(env: AppEnv): DeploymentProfile {
  return {
    deployment: "local",
    auth: "local",
    tenancy: env.tenancyMode ?? "single",
    execution: "local",
    storage: env.storageMode ?? "sqlite",
    ui: "local",
  };
}

/** Persisted profiles from older installations converge to the local product. */
export function resolveProfileFromSettings(_settings: Record<string, string>, env: AppEnv): DeploymentProfile {
  return resolveDeploymentProfile(env);
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
