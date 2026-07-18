import { describe, expect, it } from "vitest";

import { SqliteBotRepository } from "../../src/adapters/local/sqlite-bot-repository.js";
import { createTenantId, createUserId } from "../../src/identity/types.js";
import { createControlStore } from "../../src/services/stores/control-store/index.js";
import { makeTempRoot } from "../helpers/temp-db.js";

describe("SqliteBotRepository", () => {
  it("preserves identity, ownership, config and tenant queries", async () => {
    const store = createControlStore(makeTempRoot());
    const bots = new SqliteBotRepository(store);
    const tenantId = createTenantId("tnt_bot_port");
    const ownerId = createUserId("usr_bot_owner");
    try {
      store.createTenant({ id: tenantId, displayName: "Bots" });
      store.createUser({ id: ownerId, displayName: "Owner" });
      store.upsertMembership({ userId: ownerId, tenantId, role: "owner" });

      const bot = await bots.create({ tenantId, ownerId, displayName: "Assistant" });
      expect(await bots.isOwnedBy(bot.id, ownerId)).toBe(true);
      expect(await bots.assertOwner(bot.id, ownerId)).toEqual(bot);
      expect(await bots.listOwnedBotIdsForTenant(ownerId, tenantId)).toEqual([bot.id]);
      expect(await bots.listByTenant(tenantId)).toEqual([expect.objectContaining({ id: bot.id, ownerName: "Owner" })]);

      const config = await bots.updateConfig(bot.id, {
        enabled: true,
        feishu: { enabled: true, app_secret: "secret", receive_mode: "webhook" },
      });
      expect(config.feishu.app_secret).toBe("***");
      expect((await bots.getRuntimeConfig(bot.id))?.feishu.app_secret).toBe("secret");
      expect(await bots.listAllEnabledFeishu()).toEqual([expect.objectContaining({ bot_id: bot.id })]);

      await bots.rename(bot.id, "Renamed");
      expect(await bots.get(bot.id)).toMatchObject({ displayName: "Renamed" });
      expect(await bots.delete(bot.id)).toBe(true);
      expect(await bots.get(bot.id)).toBeNull();
    } finally {
      store.close();
    }
  });

  it("preserves cron CRUD and due-task filtering", async () => {
    const store = createControlStore(makeTempRoot());
    const bots = new SqliteBotRepository(store);
    const tenantId = createTenantId("tnt_bot_cron_port");
    const ownerId = createUserId("usr_bot_cron_owner");
    try {
      store.createTenant({ id: tenantId, displayName: "Cron" });
      store.createUser({ id: ownerId, displayName: "Owner" });
      store.upsertMembership({ userId: ownerId, tenantId, role: "owner" });
      const bot = await bots.create({ tenantId, ownerId, displayName: "Cron Bot" });
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
      expect(await bots.listCronTasks(bot.id)).toEqual([task]);
      expect(await bots.listDueCronTasks(11)).toEqual([{ botId: bot.id, taskId: "daily" }]);
      expect(await bots.updateCronTask(bot.id, "daily", { last_result: "ok" })).toMatchObject({ last_result: "ok" });
      expect(await bots.deleteCronTask(bot.id, "daily")).toBe(true);
      expect(await bots.getCronTask(bot.id, "daily")).toBeNull();
    } finally {
      store.close();
    }
  });
});
