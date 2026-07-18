import { randomUUID } from "node:crypto";

import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { createPostgresControlPlaneAdapter } from "../../src/adapters/saas/postgres/control-plane-adapter.js";
import { PostgresBotRepository } from "../../src/adapters/saas/postgres/bot-repository.js";
import type { SecretCoordinates, SecretMutation, SecretResolver } from "../../src/contracts/secret-resolver.js";
import type { ControlPlane } from "../../src/contracts/control-plane/index.js";
import { createTenantId, createUserId } from "../../src/identity/types.js";
import { runControlPlaneContract } from "../contracts/control-plane-contract.js";

const databaseUrl = process.env.DATABASE_URL?.trim();
const postgresEnabled = databaseUrl != null;
const adminPool = postgresEnabled ? new Pool({ connectionString: databaseUrl, max: 2 }) : null;
const schemas: string[] = [];

afterAll(async () => {
  if (adminPool == null) return;
  for (const schema of schemas) {
    await adminPool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }
  await adminPool.end();
});

describe.skipIf(!postgresEnabled)("PostgreSQL ControlPlane", () => {
  runControlPlaneContract("PostgreSQL", async () => {
    const connectionString = await createIsolatedConnectionString();
    return {
      controlPlane: await openPostgresControlPlane(connectionString),
      reopen: async () => await openPostgresControlPlane(connectionString),
    };
  });

  it("makes install, session revocation and suspension visible across instances", async () => {
    const suffix = idSuffix();
    const connectionString = await createIsolatedConnectionString();
    const first = await openPostgresControlPlane(connectionString);
    const second = await openPostgresControlPlane(connectionString);
    const tenantId = createTenantId(`tnt_visible_${suffix}`);
    const userId = createUserId(`usr_visible_${suffix}`);
    try {
      await first.provisioning.install({
        tenant: { id: tenantId, displayName: "Visible" },
        admin: {
          id: userId,
          displayName: "Visible Admin",
          username: `visible-${suffix}`,
          passwordHash: "visible-hash",
        },
        settings: { deployment_mode: "saas", auth_mode: "password" },
      });
      await expect(second.users.findCredentialsByUsername(`visible-${suffix}`))
        .resolves.toMatchObject({ id: userId, passwordHash: "visible-hash" });
      await expect(second.memberships.findFirstActiveForLogin(userId, false))
        .resolves.toEqual({ tenantId, role: "owner" });

      const jti = `jti-visible-${suffix}`;
      await first.sessions.record({ jti, userId, tenantId, issuedAt: 10, expiresAt: 100 });
      await expect(second.sessions.isRevoked(tenantId, jti)).resolves.toBe(false);
      await second.sessions.revoke(jti);
      await expect(first.sessions.isRevoked(tenantId, jti)).resolves.toBe(true);

      await second.tenants.setStatus(tenantId, "suspended");
      await expect(first.memberships.findFirstActiveForLogin(userId, false)).resolves.toBeNull();
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  }, 30_000);

  it("serializes concurrent install attempts from separate instances", async () => {
    const suffix = idSuffix();
    const connectionString = await createIsolatedConnectionString();
    const first = await openPostgresControlPlane(connectionString);
    const second = await openPostgresControlPlane(connectionString);
    try {
      const results = await Promise.allSettled([
        first.provisioning.install({
          tenant: { id: createTenantId(`tnt_install_a_${suffix}`), displayName: "Install A" },
          settings: { deployment_mode: "saas" },
        }),
        second.provisioning.install({
          tenant: { id: createTenantId(`tnt_install_b_${suffix}`), displayName: "Install B" },
          settings: { deployment_mode: "saas" },
        }),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await first.tenants.list()).filter((tenant) => tenant.id.startsWith("tnt_install_")))
        .toHaveLength(1);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  }, 30_000);

  it("preserves owner and platform-admin invariants across separate instances", async () => {
    const suffix = idSuffix();
    const connectionString = await createIsolatedConnectionString();
    const first = await openPostgresControlPlane(connectionString);
    const second = await openPostgresControlPlane(connectionString);
    const tenantId = createTenantId(`tnt_race_${suffix}`);
    const ownerA = createUserId(`usr_owner_a_${suffix}`);
    const ownerB = createUserId(`usr_owner_b_${suffix}`);
    const adminA = createUserId(`usr_admin_a_${suffix}`);
    const adminB = createUserId(`usr_admin_b_${suffix}`);
    try {
      await first.users.create({ id: ownerA, displayName: "Owner A" });
      await first.users.create({ id: ownerB, displayName: "Owner B" });
      await first.provisioning.createTenantWithOwner({ tenant: { id: tenantId, displayName: "Race" }, ownerUserId: ownerA });
      await first.memberships.upsert({ userId: ownerB, tenantId, role: "owner" });
      const ownerResults = await Promise.allSettled([
        first.memberships.delete(ownerA, tenantId),
        second.memberships.delete(ownerB, tenantId),
      ]);
      expect(ownerResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(ownerResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect((await first.memberships.listByTenant(tenantId)).filter((membership) => membership.role === "owner"))
        .toHaveLength(1);

      await first.users.create({ id: adminA, displayName: "Admin A", platformRole: "admin" });
      await first.users.create({ id: adminB, displayName: "Admin B", platformRole: "admin" });
      const adminResults = await Promise.allSettled([
        first.users.setStatus(adminA, "disabled"),
        second.users.setStatus(adminB, "disabled"),
      ]);
      expect(adminResults.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(adminResults.filter((result) => result.status === "rejected")).toHaveLength(1);
      const admins = await Promise.all([first.users.get(adminA), second.users.get(adminB)]);
      expect(admins.filter((user) => user?.platformRole === "admin" && user.status === "active"))
        .toHaveLength(1);
    } finally {
      await Promise.allSettled([first.close(), second.close()]);
    }
  }, 30_000);

  it("persists Bot config, resolver-backed secrets and cron tasks in Control v2", async () => {
    const suffix = idSuffix();
    const connectionString = await createIsolatedConnectionString();
    const control = await openPostgresControlPlane(connectionString);
    const tenantId = createTenantId(`tnt_bot_${suffix}`);
    const ownerId = createUserId(`usr_bot_owner_${suffix}`);
    const secrets = new TestSecretResolver();
    const bots = new PostgresBotRepository((control as unknown as { pool: Pool }).pool, secrets);
    try {
      await control.provisioning.install({
        tenant: { id: tenantId, displayName: "Bot Tenant" },
        admin: { id: ownerId, displayName: "Bot Owner", username: `bot-owner-${suffix}`, passwordHash: "hash" },
        settings: {},
      });
      const bot = await bots.create({ tenantId, ownerId, displayName: "Feishu Bot" });
      const updated = await bots.updateConfig(bot.id, {
        enabled: true,
        feishu: {
          enabled: true,
          app_id: "cli_app",
          app_secret: "app-secret",
          token: "verify-token",
          encoding_aes_key: "aes-key",
          route_token: "route-token",
          receive_mode: "webhook",
        },
      });
      expect(updated).toMatchObject({ enabled: true, feishu: { app_secret: "***", token: "***", encoding_aes_key: "***" } });
      await expect(bots.getRuntimeConfig(bot.id)).resolves.toMatchObject({
        feishu: { app_secret: "app-secret", token: "verify-token", encoding_aes_key: "aes-key", route_token: "route-token" },
      });
      const task = await bots.createCronTask(bot.id, {
        task_id: "hourly", cron: "0 * * * *", task: "run", entry_agent: null, enabled: true, push_platform: null, push_chat_id: null, next_run: 1,
      });
      expect(task).toMatchObject({ bot_id: bot.id, task_id: "hourly" });
      expect(await bots.listByTenant(tenantId)).toHaveLength(1);
      expect(await bots.delete(bot.id)).toBe(true);
      expect(await bots.get(bot.id)).toBeNull();
      expect(secrets.values.size).toBe(0);
    } finally {
      await control.close();
    }
  }, 30_000);
});

class TestSecretResolver implements SecretResolver {
  readonly values = new Map<string, string>();
  async resolve(coordinates: SecretCoordinates): Promise<string | null> { return this.values.get(key(coordinates)) ?? null; }
  async mutate(coordinates: SecretCoordinates, mutation: SecretMutation): Promise<void> {
    const id = key(coordinates);
    if (mutation.kind === "clear") this.values.delete(id);
    if (mutation.kind === "set") this.values.set(id, mutation.value);
  }
  async close(): Promise<void> {}
}

function key(coordinates: SecretCoordinates): string {
  return `${coordinates.tenantId}:${coordinates.purpose}:${coordinates.resourceId}:${coordinates.field}`;
}

async function createIsolatedConnectionString(): Promise<string> {
  if (databaseUrl == null || adminPool == null) throw new Error("DATABASE_URL is required");
  const schema = `control_e2e_${randomUUID().replaceAll("-", "")}`;
  schemas.push(schema);
  await adminPool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-csearch_path=${schema},public`);
  return url.toString();
}

async function openPostgresControlPlane(connectionString: string): Promise<ControlPlane> {
  return await createPostgresControlPlaneAdapter({ connectionString });
}

function idSuffix(): string {
  return randomUUID().replaceAll("-", "").slice(0, 16);
}
