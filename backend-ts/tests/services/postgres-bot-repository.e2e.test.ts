import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { PostgresBotRepository } from "../../src/adapters/saas/postgres/bot-repository.js";
import { createPostgresControlPlaneAdapter } from "../../src/adapters/saas/postgres/control-plane-adapter.js";
import { createPostgresSecretResolver } from "../../src/adapters/saas/postgres/control-secret-resolver.js";
import { createTenantId, createUserId } from "../../src/identity/types.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const adminPool = databaseUrl == null ? null : new Pool({ connectionString: databaseUrl, max: 2 });
const schemas: string[] = [];

afterAll(async () => {
  if (!adminPool) return;
  for (const schema of schemas) await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await adminPool.end();
});

describe.skipIf(databaseUrl == null)("PostgreSQL BotRepository", () => {
  it("persists bot/config/cron through v2 and protects secrets", async () => {
    if (!databaseUrl || !adminPool) throw new Error("DATABASE_URL is required");
    const schema = `bot_e2e_${randomUUID().replaceAll("-", "")}`;
    schemas.push(schema);
    await adminPool.query(`CREATE SCHEMA ${schema}`);
    const connectionString = schemaConnection(schema);
    const pool = new Pool({ connectionString, max: 4 });
    const control = await createPostgresControlPlaneAdapter({ connectionString, pool });
    const secrets = await createPostgresSecretResolver({ connectionString, pool, runMigrations: false, masterKey: Buffer.alloc(32, 21) });
    const bots = new PostgresBotRepository(pool, secrets);
    const tenantId = createTenantId(`tnt_bot_pg_${suffix()}`);
    const ownerId = createUserId(`usr_bot_owner_pg_${suffix()}`);
    try {
      await control.tenants.create({ id: tenantId, displayName: "Bot Tenant" });
      await control.users.create({ id: ownerId, displayName: "Owner" });
      await control.memberships.upsert({ userId: ownerId, tenantId, role: "owner" });

      const bot = await bots.create({ tenantId, ownerId, displayName: "PG Bot" });
      const updated = await bots.updateConfig(bot.id, {
        enabled: true,
        feishu: {
          enabled: true,
          app_id: "cli_pg",
          app_secret: "app-secret",
          token: "verify-token",
          encoding_aes_key: "aes-key",
          route_token: "route-token",
          receive_mode: "webhook",
        },
      });
      expect(updated.feishu.app_secret).toBe("***");
      expect(updated.feishu.token).toBe("***");
      expect(updated.feishu.encoding_aes_key).toBe("***");
      expect(updated.feishu.route_token).toBe("route-token");

      const runtime = await bots.getRuntimeConfig(bot.id);
      expect(runtime?.feishu).toMatchObject({ app_secret: "app-secret", token: "verify-token", encoding_aes_key: "aes-key", route_token: "route-token" });
      expect(await bots.listAllEnabledFeishu()).toHaveLength(1);

      const task = await bots.createCronTask(bot.id, {
        task_id: "daily",
        cron: "0 9 * * *",
        task: "report",
        entry_agent: null,
        enabled: true,
        push_platform: null,
        push_chat_id: null,
        next_run: 10,
      });
      expect(await bots.listDueCronTasks(11)).toEqual([{ botId: bot.id, taskId: task.task_id }]);

      expect(await pool.query("SELECT COUNT(*)::int AS count FROM control_secret_envelopes WHERE resource_id=$1", [bot.id])).toMatchObject({ rows: [{ count: 4 }] });
      expect(await bots.delete(bot.id)).toBe(true);
      expect(await pool.query("SELECT COUNT(*)::int AS count FROM control_secret_envelopes WHERE resource_id=$1", [bot.id])).toMatchObject({ rows: [{ count: 0 }] });
    } finally {
      await secrets.close();
      await control.close();
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
