import { z } from "zod";
import { createTenantId, createUserId } from "@ragsystem/backend-core/identity/types.js";
import { PermissionModeSchema } from "@ragsystem/backend-core/contracts/runtime/permissions.js";

const TenantIdSchema = z.string().transform(createTenantId);
const UserIdSchema = z.string().transform(createUserId);

/** 投递目标：channel 由投递通道插件定义（如 "feishu"）；target 为通道内目标（如 chat_id）。 */
export const SchedulerDeliverySchema = z.object({
  channel: z.string().trim().min(1),
  target: z.string().nullable().optional().default(null),
  /** 通道实现可选使用的发送者引用（如飞书 bot 的 user id）。 */
  bot_id: z.string().nullable().optional().default(null),
});

export const SchedulerTaskSchema = z.object({
  tenant_id: TenantIdSchema,
  task_id: z.string().trim().min(1).max(120),
  /** 标准 5 段 cron 表达式（分 时 日 月 周）。 */
  cron: z.string().trim().min(1),
  /** 到点执行的自然语言任务内容，交给 entry_agent 运行。 */
  task: z.string().trim().min(1),
  /** 绑定 team；null 表示新建会话时快照租户当前激活 team。 */
  team: z.string().nullable().optional().default(null),
  entry_agent: z.string().nullable().optional().default(null),
  /** 固定会话覆盖；null 表示按任务派生确定性会话。 */
  session_id: z.string().nullable().optional().default(null),
  enabled: z.boolean().optional().default(true),
  permission_mode: PermissionModeSchema.optional().default("relaxed"),
  /** 会话 owner（任务创建者），运行时会话归属此用户。 */
  owner_user_id: UserIdSchema,
  delivery: SchedulerDeliverySchema.nullable().optional().default(null),
  next_run: z.number().nullable().optional().default(null),
  last_run: z.number().nullable().optional().default(null),
  last_result: z.string().nullable().optional().default(null),
  created_at: z.string(),
  updated_at: z.string(),
});

export const SchedulerTaskCreateSchema = SchedulerTaskSchema.omit({
  tenant_id: true,
  owner_user_id: true,
  next_run: true,
  last_run: true,
  last_result: true,
  created_at: true,
  updated_at: true,
});

export const SchedulerTaskUpdateSchema = SchedulerTaskCreateSchema.partial();

export type SchedulerDelivery = z.infer<typeof SchedulerDeliverySchema>;
export type SchedulerTask = z.infer<typeof SchedulerTaskSchema>;
export type SchedulerTaskCreate = z.infer<typeof SchedulerTaskCreateSchema>;
export type SchedulerTaskUpdate = z.infer<typeof SchedulerTaskUpdateSchema>;
