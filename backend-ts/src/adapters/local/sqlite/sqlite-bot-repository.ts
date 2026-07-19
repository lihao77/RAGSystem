import { randomUUID } from "node:crypto";
import type { BotRepository } from "../../../contracts/bot-repository.js";
import type { BotCronTaskClaim } from "../../../contracts/bot-repository.js";
import type { ControlStore } from "./control-store/index.js";

/** Async Bot boundary backed by the Local control SQLite database. */
export class SqliteBotRepository implements BotRepository {
  private readonly cronClaims = new Map<string, BotCronTaskClaim>();
  constructor(readonly store: ControlStore) {}

  async create(input: Parameters<BotRepository["create"]>[0]) { return this.store.createBot(input); }
  async get(botId: Parameters<BotRepository["get"]>[0]) { return this.store.getBot(botId); }
  async rename(botId: Parameters<BotRepository["rename"]>[0], displayName: string) { return this.store.updateUser(botId, displayName); }
  async delete(botId: Parameters<BotRepository["delete"]>[0]) { return this.store.deleteBot(botId); }
  async isOwnedBy(botId: Parameters<BotRepository["isOwnedBy"]>[0], ownerId: Parameters<BotRepository["isOwnedBy"]>[1]) { return this.store.isBotOwnedBy(botId, ownerId); }
  async assertOwner(botId: Parameters<BotRepository["assertOwner"]>[0], ownerId: Parameters<BotRepository["assertOwner"]>[1]) { return this.store.assertBotOwner(botId, ownerId); }
  async listByOwner(ownerId: Parameters<BotRepository["listByOwner"]>[0]) { return this.store.listBotsByOwner(ownerId); }
  async listWithConfigByOwner(ownerId: Parameters<BotRepository["listWithConfigByOwner"]>[0]) { return this.store.listBotsWithConfig(ownerId); }
  async listOwnedBotIdsForTenant(ownerId: Parameters<BotRepository["listOwnedBotIdsForTenant"]>[0], tenantId: Parameters<BotRepository["listOwnedBotIdsForTenant"]>[1]) {
    return this.store.listBotsByOwner(ownerId)
      .filter((bot) => this.store.getMembership(bot.id, tenantId) !== null)
      .map((bot) => bot.id);
  }
  async listAll() { return this.store.listAllBots(); }
  async listByTenant(tenantId: Parameters<BotRepository["listByTenant"]>[0]) { return this.store.listBotsByTenant(tenantId); }
  async getConfig(botId: Parameters<BotRepository["getConfig"]>[0]) { return this.store.getBotConfig(botId); }
  async getRuntimeConfig(botId: Parameters<BotRepository["getRuntimeConfig"]>[0]) { return this.store.getBotRuntimeConfig(botId); }
  async updateConfig(botId: Parameters<BotRepository["updateConfig"]>[0], patch: Parameters<BotRepository["updateConfig"]>[1]) { return this.store.updateBotConfig(botId, patch); }
  async listAllEnabledFeishu() { return this.store.getAllEnabledFeishuBots(); }
  async resolveWebhookTarget(routeToken: string) {
    const config = this.store.getAllEnabledFeishuBots().find((candidate) =>
      candidate.feishu.receive_mode === "webhook" && candidate.feishu.route_token === routeToken);
    return config ? { tenantId: config.tenant_id, botId: config.bot_id } : null;
  }
  async listCronTasks(botId: Parameters<BotRepository["listCronTasks"]>[0]) { return this.store.listBotCronTasks(botId); }
  async claimDueCronTasks(input: Parameters<BotRepository["claimDueCronTasks"]>[0]): Promise<BotCronTaskClaim[]> {
    const leaseSeconds = Math.max(5, Math.min(Math.trunc(input.leaseSeconds ?? 300), 86_400));
    const claims: BotCronTaskClaim[] = [];
    for (const due of this.store.findDueCronTasks(input.now).slice(0, input.limit ?? 100)) {
      const key = `${due.botId}:${due.taskId}`;
      const existing = this.cronClaims.get(key);
      if (existing && existing.leaseExpiresAt > input.now) continue;
      const claim = { botId: due.botId, taskId: due.taskId, claimToken: randomUUID(), attemptId: randomUUID(), leaseOwner: input.leaseOwner, leaseExpiresAt: input.now + leaseSeconds };
      this.cronClaims.set(key, claim);
      claims.push(claim);
    }
    return claims;
  }
  async completeCronTaskClaim(input: { botId: Parameters<BotRepository["get"]>[0]; taskId: string; claimToken: string }): Promise<boolean> {
    const key = `${input.botId}:${input.taskId}`;
    const claim = this.cronClaims.get(key);
    if (!claim || claim.claimToken !== input.claimToken) return false;
    this.cronClaims.delete(key);
    return true;
  }
  async releaseCronTaskClaim(input: { botId: Parameters<BotRepository["get"]>[0]; taskId: string; claimToken: string }): Promise<boolean> {
    return this.completeCronTaskClaim(input);
  }
  async getCronTask(botId: Parameters<BotRepository["getCronTask"]>[0], taskId: string) { return this.store.getBotCronTask(botId, taskId); }
  async createCronTask(botId: Parameters<BotRepository["createCronTask"]>[0], input: Parameters<BotRepository["createCronTask"]>[1]) { return this.store.createBotCronTask(botId, input); }
  async updateCronTask(botId: Parameters<BotRepository["updateCronTask"]>[0], taskId: string, patch: Parameters<BotRepository["updateCronTask"]>[2]) { return this.store.updateBotCronTask(botId, taskId, patch); }
  async deleteCronTask(botId: Parameters<BotRepository["deleteCronTask"]>[0], taskId: string) { return this.store.deleteBotCronTask(botId, taskId); }
}
