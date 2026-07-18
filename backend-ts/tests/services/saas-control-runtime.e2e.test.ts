import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { buildApp } from "../../src/app.js";
import { loadEnv } from "../../src/config/env.js";
import { createSaaSControlRuntime } from "../../src/services/runtime/saas-control-runtime.js";
import { createSaaSMemoryRuntime } from "../../src/services/runtime/saas-memory-runtime.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const adminPool = databaseUrl == null ? null : new Pool({ connectionString: databaseUrl, max: 2 });
const schemas: string[] = [];

afterAll(async () => {
  if (!adminPool) return;
  for (const schema of schemas) await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

describe.skipIf(databaseUrl == null)("SaaS Control runtime composition", () => {
  it("starts v2 Control, Bot and Widget repositories from one PostgreSQL pool", async () => {
    if (!databaseUrl || !adminPool) throw new Error("DATABASE_URL is required");
    const schema = `control_runtime_e2e_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const connectionString = schemaConnection(schema);
    const dataRoot = await fsTempRoot();
    const env = loadEnv({
      DEPLOYMENT_MODE: "saas",
      AUTH_MODE: "password",
      TENANCY_MODE: "multi",
      EXECUTION_MODE: "remote",
      STORAGE_MODE: "postgres",
      DATABASE_URL: connectionString,
      CONTROL_STORAGE_MODE: "postgres",
      CONTROL_DATABASE_URL: connectionString,
      CONTROL_SECRET_MASTER_KEY: Buffer.alloc(32, 41).toString("base64"),
      SESSION_JWT_SECRET: "control-runtime-test-session-secret-0123456789",
      RAG_DATA_ROOT: dataRoot,
    });
    const memory = await createSaaSMemoryRuntime({ connectionString, poolMax: 2 });
    const control = await createSaaSControlRuntime({ connectionString, masterKey: env.controlSecretMasterKey!, poolMax: 2 });
    const app = await buildApp({ env, saasMemoryRuntime: memory, controlRuntime: control });
    try {
      await app.ready();
      const response = await app.inject({ method: "GET", url: "/readyz" });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ checks: { control_schema_version: 3 } });
    } finally {
      await app.close();
    }
  }, 30_000);
});

async function fsTempRoot(): Promise<string> {
  const root = path.join(os.tmpdir(), `ragsystem-control-runtime-${randomUUID()}`);
  return root;
}

function schemaConnection(schema: string): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}
