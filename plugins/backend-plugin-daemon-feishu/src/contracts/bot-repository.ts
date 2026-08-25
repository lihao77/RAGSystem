import type { BotRepository } from "./bot-directory.js";
import type { Bot } from "@ragsystem/backend-core/contracts/control-plane/user.js";
import type { TenantId, UserId } from "@ragsystem/backend-core/identity/types.js";
import type {
  BotConfig,
  BotConfigUpdate,
  BotSummary,
  TenantBotSummary,
} from "./bot.js";

export type BotWithConfig = Bot & { config: BotConfig };
export interface BotWebhookTarget { tenantId: TenantId; botId: UserId }

export interface DaemonBotRepository extends BotRepository {
  listWithConfigByOwner(ownerId: UserId): Promise<BotWithConfig[]>;
  listAll(): Promise<BotSummary[]>;
  listByTenant(tenantId: TenantId): Promise<TenantBotSummary[]>;
  getConfig(botId: UserId): Promise<BotConfig | null>;
  getRuntimeConfig(botId: UserId): Promise<BotConfig | null>;
  updateConfig(botId: UserId, patch: BotConfigUpdate): Promise<BotConfig>;
  listAllEnabledFeishu(): Promise<BotConfig[]>;
  resolveWebhookTarget(routeToken: string): Promise<BotWebhookTarget | null>;
}
