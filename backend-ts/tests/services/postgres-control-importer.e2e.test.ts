import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresBotRepository } from "../../src/adapters/saas/postgres/bot-repository.js";
import { createPostgresControlPlaneAdapter } from "../../src/adapters/saas/postgres/control-plane-adapter.js";
import { Aes256GcmSecretResolver, PostgresSecretEnvelopeRepository } from "../../src/adapters/saas/postgres/control-secret-resolver.js";
import { importControlSnapshot, ControlImportConflictError } from "../../src/adapters/saas/postgres/control-importer.js";
import { createTenantId, createUserId } from "../../src/identity/types.js";
import { createControlStore } from "../../src/services/stores/control-store/index.js";
import { createWidgetCredentialStore } from "../../src/services/stores/widget-credential-store/index.js";
import { makeTempRoot } from "../helpers/temp-db.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const adminPool = databaseUrl == null ? null : new Pool({ connectionString: databaseUrl, max: 2 });
const schemas: string[] = [];

afterAll(async () => {
  if (!adminPool) return;
  for (const schema of schemas) await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

describe.skipIf(databaseUrl == null)("PostgreSQL Control importer", () => {
  it("imports a snapshot with secrets, is idempotent, and rejects checksum drift", async () => {
    if (!databaseUrl || !adminPool) throw new Error("DATABASE_URL is required");
    const sourceRoot = makeTempRoot();
    const source = createControlStore(sourceRoot);
    const widgetStore = createWidgetCredentialStore(source.db);
    const tenantId = createTenantId(`tnt_import_${suffix()}`);
    const ownerId = createUserId(`usr_import_${suffix()}`);
    source.createTenant({ id: tenantId, displayName: "Imported Tenant" });
    source.createUser({ id: ownerId, displayName: "Imported Owner" });
    source.upsertMembership({ userId: ownerId, tenantId, role: "owner" });
    const bot = source.createBot({ tenantId, ownerId, displayName: "Imported Bot" });
    source.updateBotConfig(bot.id, {
      enabled: true,
      feishu: { enabled: true, app_id: "import-app", app_secret: "import-secret", route_token: "import-route" },
    });
    widgetStore.ops.createApp({ tenantId, display_name: "Imported Widget", allowed_origins: ["https://import.test"] });
    source.setSetting("import_marker", "v1");

    const schema = `import_e2e_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const connectionString = schemaConnection(schema);
    const pool = new Pool({ connectionString, max: 4 });
    const masterKey = Buffer.alloc(32, 55);
    try {
      const first = await importControlSnapshot({ sourceDataRoot: sourceRoot, targetPool: pool, masterKey, importId: "import-e2e-1" });
      expect(first.alreadyImported).toBe(false);
      const second = await importControlSnapshot({ sourceDataRoot: sourceRoot, targetPool: pool, masterKey, importId: "import-e2e-1" });
      expect(second.alreadyImported).toBe(true);

      const control = await createPostgresControlPlaneAdapter({ pool, runMigrations: false });
      const secrets = new Aes256GcmSecretResolver(new PostgresSecretEnvelopeRepository(pool), masterKey);
      const bots = new PostgresBotRepository(pool, secrets);
      expect(await control.tenants.get(tenantId)).toMatchObject({ displayName: "Imported Tenant" });
      const importedBot = await bots.getRuntimeConfig(bot.id);
      expect(importedBot?.feishu).toMatchObject({ app_secret: "import-secret", route_token: "import-route" });
      expect(await pool.query("SELECT COUNT(*)::int AS count FROM control_widget_apps WHERE tenant_id=$1", [tenantId])).toMatchObject({ rows: [{ count: 1 }] });
      await secrets.close();
      await control.close();

      source.setSetting("import_marker", "v2");
      await expect(importControlSnapshot({ sourceDataRoot: sourceRoot, targetPool: pool, masterKey, importId: "import-e2e-1" }))
        .rejects.toBeInstanceOf(ControlImportConflictError);
    } finally {
      widgetStore.close();
      source.close();
      await pool.end();
    }
  }, 30_000);
});

function suffix(): string { return randomUUID().replaceAll("-", "").slice(0, 12); }
function schemaConnection(schema: string): string {
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}
