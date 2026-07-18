import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresWidgetCredentialRepository } from "../../src/adapters/saas/postgres/widget-credential-repository.js";
import { createPostgresControlPlaneAdapter } from "../../src/adapters/saas/postgres/control-plane-adapter.js";
import { createTenantId } from "../../src/identity/types.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const pool = databaseUrl == null ? null : new Pool({ connectionString: databaseUrl, max: 4 });
const schemas: string[] = [];

afterAll(async () => {
  if (pool == null) return;
  for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await pool.end();
});

describe.skipIf(databaseUrl == null)("PostgreSQL WidgetCredentialRepository", () => {
  it("preserves tenant isolation, origin checks, audit, rotate/revoke and pruning", async () => {
    if (databaseUrl == null || pool == null) throw new Error("DATABASE_URL is required");
    const connectionString = await isolatedConnectionString();
    const control = await createPostgresControlPlaneAdapter({ connectionString });
    const repository = new PostgresWidgetCredentialRepository(control.pool);
    const tenantA = createTenantId(`tnt_widget_pg_a_${idSuffix()}`);
    const tenantB = createTenantId(`tnt_widget_pg_b_${idSuffix()}`);
    try {
      await control.tenants.create({ id: tenantA, displayName: "Widget A" });
      await control.tenants.create({ id: tenantB, displayName: "Widget B" });
      const app = await repository.apps.create({ tenantId: tenantA, display_name: "A", allowed_origins: ["https://a.test"] });
      await repository.apps.create({ tenantId: tenantB, display_name: "B", allowed_origins: ["https://b.test"] });
      expect((await repository.apps.list(tenantA)).map((item) => item.app_key)).toEqual([app.app_key]);
      await expect(repository.apps.listAllowedOrigins(tenantA)).resolves.toEqual(["https://a.test"]);

      await repository.tokens.record({ tenantId: tenantA, jti: "pg-widget-live", app_key: app.app_key, issued_at: 1, expires_at: 100 });
      await expect(repository.tokens.isRevoked(tenantA, "pg-widget-live")).resolves.toBe(false);
      await expect(repository.tokens.isRevoked(tenantB, "pg-widget-live")).resolves.toBe(true);
      await expect(repository.apps.revoke(tenantB, app.app_key)).resolves.toBe(false);
      await expect(repository.tokens.isRevoked(tenantA, "pg-widget-live")).resolves.toBe(false);
      await repository.audit.record(tenantA, { app_key: app.app_key, action: "create", actor: "e2e", detail: { origin: "https://a.test" } });
      await expect(repository.audit.list(tenantA, app.app_key)).resolves.toEqual([
        expect.objectContaining({ action: "create", detail: { origin: "https://a.test" } }),
      ]);

      const rotated = await repository.apps.rotateSecret(tenantA, app.app_key);
      expect(rotated?.secret).not.toBe(app.secret);
      await expect(repository.tokens.isRevoked(tenantA, "pg-widget-live")).resolves.toBe(true);
      await repository.tokens.record({ tenantId: tenantA, jti: "pg-widget-revoked", app_key: app.app_key, issued_at: 2, expires_at: 100 });
      await expect(repository.apps.revoke(tenantA, app.app_key)).resolves.toBe(true);
      await expect(repository.tokens.isRevoked(tenantA, "pg-widget-revoked")).resolves.toBe(true);
      await repository.tokens.record({ tenantId: tenantA, jti: "pg-widget-expired", app_key: app.app_key, issued_at: 0, expires_at: 1 });
      await expect(repository.tokens.pruneExpired(1000)).resolves.toBe(3);
    } finally {
      await repository.close();
      await control.close();
    }
  }, 30_000);
});

async function isolatedConnectionString(): Promise<string> {
  if (databaseUrl == null || pool == null) throw new Error("DATABASE_URL is required");
  const schema = `widget_e2e_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  await pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}

function idSuffix(): string { return randomUUID().replaceAll("-", "").slice(0, 12); }
