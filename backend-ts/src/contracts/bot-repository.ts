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
export interface BotCronTaskClaim {
  botId: UserId;
  taskId: string;
  claimToken: string;
  attemptId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
}

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
  /** Read-only compatibility query. Multi-instance schedulers must use claimDueCronTasks. */
  listDueCronTasks(now: number): Promise<Array<{ botId: UserId; taskId: string }>>;
  /** Atomically claims due tasks with SKIP LOCKED semantics; an expired lease is reclaimable. */
  claimDueCronTasks?(input: {
    now: number;
    leaseOwner: string;
    leaseSeconds?: number;
    limit?: number;
  }): Promise<BotCronTaskClaim[]>;
  completeCronTaskClaim?(input: { botId: UserId; taskId: string; claimToken: string }): Promise<boolean>;
  releaseCronTaskClaim?(input: { botId: UserId; taskId: string; claimToken: string }): Promise<boolean>;
  getCronTask(botId: UserId, taskId: string): Promise<BotCronTask | null>;
  createCronTask(botId: UserId, input: BotCronTaskCreate & { next_run?: number | null }): Promise<BotCronTask>;
  updateCronTask(
    botId: UserId,
    taskId: string,
    patch: Partial<Omit<BotCronTask, "bot_id" | "task_id">>,
    options?: { claimToken?: string },
  ): Promise<BotCronTask | null>;
  deleteCronTask(botId: UserId, taskId: string): Promise<boolean>;
}
