import { randomUUID } from "node:crypto";
import type {
  BotCronTaskClaim,
  DaemonBotRepository,
} from "../../contracts/bot-repository.js";
import type { DatabaseSync } from "node:sqlite";
import { SqliteDaemonBotStore } from "./sqlite-daemon-bot-store.js";

/** Async Bot boundary backed by the Local control SQLite database. */
export class SqliteBotRepository implements DaemonBotRepository {
  private readonly cronClaims = new Map<string, BotCronTaskClaim>();
  readonly store: SqliteDaemonBotStore;

  constructor(database: DatabaseSync) {
    this.store = new SqliteDaemonBotStore(database);
  }

  async create(input: Parameters<DaemonBotRepository["create"]>[0]) { return this.store.createBot(input); }
  async get(botId: Parameters<DaemonBotRepository["get"]>[0]) { return this.store.getBot(botId); }
  async rename(botId: Parameters<DaemonBotRepository["rename"]>[0], displayName: string) { return this.store.updateUser(botId, displayName); }
  async delete(botId: Parameters<DaemonBotRepository["delete"]>[0]) { return this.store.deleteBot(botId); }
  async isOwnedBy(botId: Parameters<DaemonBotRepository["isOwnedBy"]>[0], ownerId: Parameters<DaemonBotRepository["isOwnedBy"]>[1]) { return this.store.isBotOwnedBy(botId, ownerId); }
  async assertOwner(botId: Parameters<DaemonBotRepository["assertOwner"]>[0], ownerId: Parameters<DaemonBotRepository["assertOwner"]>[1]) { return this.store.assertBotOwner(botId, ownerId); }
  async listByOwner(ownerId: Parameters<DaemonBotRepository["listByOwner"]>[0]) { return this.store.listBotsByOwner(ownerId); }
  async listWithConfigByOwner(ownerId: Parameters<DaemonBotRepository["listWithConfigByOwner"]>[0]) { return this.store.listBotsWithConfig(ownerId); }
  async listOwnedBotIdsForTenant(ownerId: Parameters<DaemonBotRepository["listOwnedBotIdsForTenant"]>[0], tenantId: Parameters<DaemonBotRepository["listOwnedBotIdsForTenant"]>[1]) {
    return this.store.listBotsByOwner(ownerId)
      .filter((bot) => this.store.getMembership(bot.id, tenantId) !== null)
      .map((bot) => bot.id);
  }
  async listAll() { return this.store.listAllBots(); }
  async listByTenant(tenantId: Parameters<DaemonBotRepository["listByTenant"]>[0]) { return this.store.listBotsByTenant(tenantId); }
  async getConfig(botId: Parameters<DaemonBotRepository["getConfig"]>[0]) { return this.store.getBotConfig(botId); }
  async getRuntimeConfig(botId: Parameters<DaemonBotRepository["getRuntimeConfig"]>[0]) { return this.store.getBotRuntimeConfig(botId); }
  async updateConfig(botId: Parameters<DaemonBotRepository["updateConfig"]>[0], patch: Parameters<DaemonBotRepository["updateConfig"]>[1]) { return this.store.updateBotConfig(botId, patch); }
  async listAllEnabledFeishu() { return this.store.getAllEnabledFeishuBots(); }
  async resolveWebhookTarget(routeToken: string) {
    const config = this.store.getAllEnabledFeishuBots().find((candidate) =>
      candidate.feishu.receive_mode === "webhook" && candidate.feishu.route_token === routeToken);
    return config ? { tenantId: config.tenant_id, botId: config.bot_id } : null;
  }
  async listCronTasks(botId: Parameters<DaemonBotRepository["listCronTasks"]>[0]) { return this.store.listBotCronTasks(botId); }
  async claimDueCronTasks(input: Parameters<DaemonBotRepository["claimDueCronTasks"]>[0]): Promise<BotCronTaskClaim[]> {
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
  async completeCronTaskClaim(input: { botId: Parameters<DaemonBotRepository["get"]>[0]; taskId: string; claimToken: string }): Promise<boolean> {
    const key = `${input.botId}:${input.taskId}`;
    const claim = this.cronClaims.get(key);
    if (!claim || claim.claimToken !== input.claimToken) return false;
    this.cronClaims.delete(key);
    return true;
  }
  async releaseCronTaskClaim(input: { botId: Parameters<DaemonBotRepository["get"]>[0]; taskId: string; claimToken: string }): Promise<boolean> {
    return this.completeCronTaskClaim(input);
  }
  async getCronTask(botId: Parameters<DaemonBotRepository["getCronTask"]>[0], taskId: string) { return this.store.getBotCronTask(botId, taskId); }
  async createCronTask(botId: Parameters<DaemonBotRepository["createCronTask"]>[0], input: Parameters<DaemonBotRepository["createCronTask"]>[1]) { return this.store.createBotCronTask(botId, input); }
  async updateCronTask(botId: Parameters<DaemonBotRepository["updateCronTask"]>[0], taskId: string, patch: Parameters<DaemonBotRepository["updateCronTask"]>[2]) { return this.store.updateBotCronTask(botId, taskId, patch); }
  async deleteCronTask(botId: Parameters<DaemonBotRepository["deleteCronTask"]>[0], taskId: string) { return this.store.deleteBotCronTask(botId, taskId); }
}
