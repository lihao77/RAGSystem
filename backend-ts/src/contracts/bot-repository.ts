import type {
  BotConfig,
  BotConfigUpdate,
  BotCronTask,
  BotCronTaskCreate,
  BotSummary,
  TenantBotSummary,
} from "./bot.js";
import type { Bot } from "./user.js";
import type { TenantId, UserId } from "../identity/types.js";

export type BotWithConfig = Bot & { config: BotConfig };

export interface BotRepository {
  create(input: { tenantId: TenantId; ownerId: UserId; displayName: string }): Promise<Bot>;
  get(botId: UserId): Promise<Bot | null>;
  rename(botId: UserId, displayName: string): Promise<boolean>;
  delete(botId: UserId): Promise<boolean>;
  isOwnedBy(botId: UserId | string, ownerId: UserId | string): Promise<boolean>;
  assertOwner(botId: UserId, ownerId: UserId): Promise<Bot>;
  listByOwner(ownerId: UserId): Promise<Bot[]>;
  listWithConfigByOwner(ownerId: UserId): Promise<BotWithConfig[]>;
  listOwnedBotIdsForTenant(ownerId: UserId, tenantId: TenantId): Promise<UserId[]>;
  listAll(): Promise<BotSummary[]>;
  listByTenant(tenantId: TenantId): Promise<TenantBotSummary[]>;

  getConfig(botId: UserId): Promise<BotConfig | null>;
  getRuntimeConfig(botId: UserId): Promise<BotConfig | null>;
  updateConfig(botId: UserId, patch: BotConfigUpdate): Promise<BotConfig>;
  listAllEnabledFeishu(): Promise<BotConfig[]>;

  listCronTasks(botId: UserId): Promise<BotCronTask[]>;
  listDueCronTasks(now: number): Promise<Array<{ botId: UserId; taskId: string }>>;
  getCronTask(botId: UserId, taskId: string): Promise<BotCronTask | null>;
  createCronTask(botId: UserId, input: BotCronTaskCreate & { next_run?: number | null }): Promise<BotCronTask>;
  updateCronTask(botId: UserId, taskId: string, patch: Partial<Omit<BotCronTask, "bot_id" | "task_id">>): Promise<BotCronTask | null>;
  deleteCronTask(botId: UserId, taskId: string): Promise<boolean>;
}
