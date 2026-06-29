import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import os from "node:os";
import path from "node:path";

const EnvSchema = z.object({
  BACKEND_TS_HOST: z.string().optional(),
  BACKEND_TS_PORT: z.string().optional(),
  BACKEND_TS_LOG_LEVEL: z.string().optional(),
  BACKEND_TS_DB_PATH: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  NODE_ENV: z.string().optional(),
  PORT: z.string().optional(),
  RAG_DATA_ROOT: z.string().optional(),
  WIDGET_JWT_SECRET: z.string().optional(),
});

export interface AppEnv {
  host: string;
  port: number;
  logLevel: string;
  nodeEnv: string;
  corsOrigins: string[] | boolean;
  dataRoot: string;
  dbPath: string;
  /** widget JWT 签名密钥；未设则 widget 鉴权不启用。 */
  widgetJwtSecret?: string | undefined;
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

  const dataRoot = env.RAG_DATA_ROOT?.trim() || path.join(os.homedir(), ".ragsystem");
  const dbPath = env.BACKEND_TS_DB_PATH?.trim() || path.join(dataRoot, "db", "ragsystem.db");

  return {
    host: env.BACKEND_TS_HOST ?? "0.0.0.0",
    port,
    logLevel: env.BACKEND_TS_LOG_LEVEL ?? "info",
    nodeEnv: env.NODE_ENV ?? "development",
    corsOrigins: parseCorsOrigins(env.CORS_ORIGINS),
    dataRoot,
    dbPath,
    widgetJwtSecret: env.WIDGET_JWT_SECRET?.trim() || undefined,
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
