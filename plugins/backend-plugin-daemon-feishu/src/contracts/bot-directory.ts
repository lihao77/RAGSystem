import type { Bot } from "@ragsystem/backend-core/contracts/control-plane/user.js";
import type { TenantId, UserId } from "@ragsystem/backend-core/identity/types.js";

export interface BotDirectoryEntry {
  id: UserId;
  displayName: string;
  createdAt: string;
  status: "active" | "disabled";
  ownerName: string;
}

export interface BotRepository {
  create(input: { tenantId: TenantId; ownerId: UserId; displayName: string }): Promise<Bot>;
  get(botId: UserId): Promise<Bot | null>;
  rename(botId: UserId, displayName: string): Promise<boolean>;
  delete(botId: UserId): Promise<boolean>;
  isOwnedBy(botId: UserId | string, ownerId: UserId | string): Promise<boolean>;
  assertOwner(botId: UserId, ownerId: UserId): Promise<Bot>;
  listByOwner(ownerId: UserId): Promise<Bot[]>;
  listOwnedBotIdsForTenant(ownerId: UserId, tenantId: TenantId): Promise<UserId[]>;
  listByTenant(tenantId: TenantId): Promise<BotDirectoryEntry[]>;
}
