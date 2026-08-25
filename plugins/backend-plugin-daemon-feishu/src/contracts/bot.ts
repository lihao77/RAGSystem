import { z } from "zod";
import { createTenantId, createUserId } from "@ragsystem/backend-core/identity/types.js";
import { UserStatusSchema } from "@ragsystem/backend-core/contracts/control-plane/user.js";
import { PermissionModeSchema } from "@ragsystem/backend-core/contracts/runtime/permissions.js";

const UserIdSchema = z.string().transform(createUserId);
const TenantIdSchema = z.string().transform(createTenantId);

export const PlatformTypeSchema = z.enum(["feishu"]);
export const FeishuReceiveModeSchema = z.enum(["webhook", "long_connection"]);

export const BotFeishuConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  app_id: z.string().nullable().optional().default(null),
  app_secret: z.string().nullable().optional().default(null),
  token: z.string().nullable().optional().default(null),
  encoding_aes_key: z.string().nullable().optional().default(null),
  receive_mode: FeishuReceiveModeSchema.optional().default("webhook"),
  route_token: z.string().nullable().optional().default(null),
  default_chat_id: z.string().nullable().optional().default(null),
});

export const BotConfigSchema = z.object({
  bot_id: UserIdSchema,
  tenant_id: TenantIdSchema,
  enabled: z.boolean().optional().default(false),
  /** 绑定 team；null 表示新建会话时快照租户当前激活 team。 */
  team: z.string().nullable().optional().default(null),
  entry_agent: z.string().nullable().optional().default(null),
  session_id: z.string().nullable().optional().default(null),
  default_session_ttl: z.number().int().positive().optional().default(86400),
  permission_mode: PermissionModeSchema.optional().default("relaxed"),
  feishu: BotFeishuConfigSchema.optional().default({}),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BotConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  team: z.string().nullable().optional(),
  entry_agent: z.string().nullable().optional(),
  session_id: z.string().nullable().optional(),
  default_session_ttl: z.number().int().positive().optional(),
  permission_mode: PermissionModeSchema.optional(),
  feishu: BotFeishuConfigSchema.partial().optional(),
});

const BotSummaryBaseSchema = z.object({
  id: UserIdSchema,
  displayName: z.string(),
  createdAt: z.string(),
  status: UserStatusSchema,
  ownerName: z.string(),
  enabled: z.boolean(),
  feishuEnabled: z.boolean(),
  feishuReceiveMode: FeishuReceiveModeSchema,
  entryAgent: z.string().nullable(),
});

export const BotSummarySchema = BotSummaryBaseSchema.extend({
  tenantId: TenantIdSchema,
  tenantName: z.string(),
});

export const TenantBotSummarySchema = BotSummaryBaseSchema;

export type PlatformType = z.infer<typeof PlatformTypeSchema>;
export type BotFeishuConfig = z.infer<typeof BotFeishuConfigSchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;
export type BotConfigUpdate = z.infer<typeof BotConfigUpdateSchema>;
export type BotSummary = z.infer<typeof BotSummarySchema>;
export type TenantBotSummary = z.infer<typeof TenantBotSummarySchema>;
