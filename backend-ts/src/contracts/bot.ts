import { z } from "zod";
import { createTenantId, createUserId } from "../identity/types.js";
import { UserStatusSchema } from "./user.js";
import { PermissionModeSchema } from "./permissions.js";

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

export const BotCronTaskSchema = z.object({
  bot_id: UserIdSchema,
  task_id: z.string().min(1),
  cron: z.string().min(1),
  task: z.string().min(1),
  entry_agent: z.string().nullable().optional().default(null),
  enabled: z.boolean().optional().default(true),
  push_platform: PlatformTypeSchema.nullable().optional().default(null),
  push_chat_id: z.string().nullable().optional().default(null),
  next_run: z.number().nullable().optional().default(null),
  last_run: z.number().nullable().optional().default(null),
  last_result: z.string().nullable().optional().default(null),
});

export const BotCronTaskCreateSchema = BotCronTaskSchema.omit({ bot_id: true, next_run: true, last_run: true, last_result: true });
export const BotCronTaskUpdateSchema = BotCronTaskCreateSchema.partial();

export const BotConfigSchema = z.object({
  bot_id: UserIdSchema,
  tenant_id: TenantIdSchema,
  enabled: z.boolean().optional().default(false),
  entry_agent: z.string().nullable().optional().default(null),
  session_id: z.string().nullable().optional().default(null),
  default_session_ttl: z.number().int().positive().optional().default(86400),
  permission_mode: PermissionModeSchema.optional().default("relaxed"),
  feishu: BotFeishuConfigSchema.optional().default({}),
  cron_tasks: z.array(BotCronTaskSchema).optional().default([]),
  created_at: z.string(),
  updated_at: z.string(),
});

export const BotConfigUpdateSchema = z.object({
  enabled: z.boolean().optional(),
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
export type BotCronTask = z.infer<typeof BotCronTaskSchema>;
export type BotCronTaskCreate = z.infer<typeof BotCronTaskCreateSchema>;
export type BotCronTaskUpdate = z.infer<typeof BotCronTaskUpdateSchema>;
export type BotConfig = z.infer<typeof BotConfigSchema>;
export type BotConfigUpdate = z.infer<typeof BotConfigUpdateSchema>;
export type BotSummary = z.infer<typeof BotSummarySchema>;
export type TenantBotSummary = z.infer<typeof TenantBotSummarySchema>;
