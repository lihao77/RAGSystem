import type { BotRepository } from "./bot-directory.js";
import type { Bot } from "@ragsystem/backend-core/contracts/control-plane/user.js";
import type { TenantId, UserId } from "@ragsystem/backend-core/identity/types.js";
import type {
  BotConfig,
  BotConfigUpdate,
  BotCronTask,
  BotCronTaskCreate,
  BotSummary,
  TenantBotSummary,
} from "./bot.js";

export type BotWithConfig = Bot & { config: BotConfig };
export interface BotWebhookTarget { tenantId: TenantId; botId: UserId }
export interface BotCronTaskClaim {
  botId: UserId;
  taskId: string;
  claimToken: string;
  attemptId: string;
  leaseOwner: string;
  leaseExpiresAt: number;
}

export interface DaemonBotRepository extends BotRepository {
  listWithConfigByOwner(ownerId: UserId): Promise<BotWithConfig[]>;
  listAll(): Promise<BotSummary[]>;
  listByTenant(tenantId: TenantId): Promise<TenantBotSummary[]>;
  getConfig(botId: UserId): Promise<BotConfig | null>;
  getRuntimeConfig(botId: UserId): Promise<BotConfig | null>;
  updateConfig(botId: UserId, patch: BotConfigUpdate): Promise<BotConfig>;
  listAllEnabledFeishu(): Promise<BotConfig[]>;
  resolveWebhookTarget(routeToken: string): Promise<BotWebhookTarget | null>;
  listCronTasks(botId: UserId): Promise<BotCronTask[]>;
  claimDueCronTasks(input: {
    now: number;
    leaseOwner: string;
    leaseSeconds?: number;
    limit?: number;
  }): Promise<BotCronTaskClaim[]>;
  completeCronTaskClaim(input: { botId: UserId; taskId: string; claimToken: string }): Promise<boolean>;
  releaseCronTaskClaim(input: { botId: UserId; taskId: string; claimToken: string }): Promise<boolean>;
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
