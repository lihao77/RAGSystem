import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresSecretResolver } from "../../src/adapters/saas/postgres/control-secret-resolver.js";
import { createPostgresControlPlaneAdapter } from "../../src/adapters/saas/postgres/control-plane-adapter.js";
import { SecretIntegrityError } from "../../src/contracts/integrations/secret-resolver.js";
import { createTenantId } from "../../src/identity/types.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const adminPool = databaseUrl ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;
const schemas: string[] = [];

afterAll(async () => {
  if (!adminPool) return;
  for (const schema of schemas) await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

describe.skipIf(!databaseUrl)("PostgreSQL secret resolver", () => {
  it("migrates, persists encrypted values and isolates tenant AAD", async () => {
    const schema = await isolatedSchema();
    const connectionString = schemaConnection(schema);
    const resolver = await createPostgresSecretResolver({ connectionString, masterKey: Buffer.alloc(32, 3) });
    const control = await createPostgresControlPlaneAdapter({ connectionString });
    const tenantA = createTenantId("tnt_pg_secret_a");
    const tenantB = createTenantId("tnt_pg_secret_b");
    const key = { purpose: "provider", resourceId: "p1", field: "api_key" };
    try {
      await control.tenants.create({ id: tenantA, displayName: "Secret A" });
      await control.tenants.create({ id: tenantB, displayName: "Secret B" });
      await resolver.mutate({ tenantId: tenantA, ...key }, { kind: "set", value: "postgres-secret" });
      await expect(resolver.resolve({ tenantId: tenantA, ...key })).resolves.toBe("postgres-secret");
      await expect(resolver.resolve({ tenantId: tenantB, ...key })).resolves.toBeNull();

      const tamper = new Pool({ connectionString });
      await tamper.query("UPDATE control_secret_envelopes SET auth_tag = decode(repeat('00', 16), 'hex')");
      await tamper.end();
      await expect(resolver.resolve({ tenantId: tenantA, ...key })).rejects.toBeInstanceOf(SecretIntegrityError);
    } finally {
      await resolver.close();
      await control.close();
    }
  }, 30_000);

  it("keeps migration idempotent and clear removes the value", async () => {
    const schema = await isolatedSchema();
    const connectionString = schemaConnection(schema);
    const first = await createPostgresSecretResolver({ connectionString, masterKey: Buffer.alloc(32, 4) });
    await first.close();
    const sharedPool = new Pool({ connectionString, max: 2 });
    const second = await createPostgresSecretResolver({ connectionString, pool: sharedPool, masterKey: Buffer.alloc(32, 4) });
    const control = await createPostgresControlPlaneAdapter({ connectionString, pool: sharedPool });
    const coordinates = {
      tenantId: createTenantId("tnt_pg_secret_clear"),
      purpose: "widget",
      resourceId: "app-1",
      field: "secret",
    };
    await control.tenants.create({ id: coordinates.tenantId, displayName: "Secret Clear" });
    await second.mutate(coordinates, { kind: "set", value: "value" });
    await second.mutate(coordinates, { kind: "clear" });
    await expect(second.resolve(coordinates)).resolves.toBeNull();
    await second.close();
    await control.close();
    await expect(sharedPool.query("SELECT 1 AS ready")).resolves.toMatchObject({ rows: [{ ready: 1 }] });
    await sharedPool.end();
  }, 30_000);
});

async function isolatedSchema(): Promise<string> {
  if (!adminPool) throw new Error("DATABASE_URL is required");
  const schema = `secret_e2e_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  return schema;
}

function schemaConnection(schema: string): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}
