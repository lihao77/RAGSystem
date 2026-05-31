import { z } from "zod";

import { PermissionPolicySchema } from "./permissions.js";

export const PlatformTypeSchema = z.enum(["feishu", "wechat", "dingtalk"]);

export const PlatformConnectionSchema = z.object({
  enabled: z.boolean().optional().default(false),
  app_id: z.string().nullable().optional().default(null),
  app_secret: z.string().nullable().optional().default(null),
  token: z.string().nullable().optional().default(null),
  encoding_aes_key: z.string().nullable().optional().default(null),
  webhook_url: z.string().nullable().optional().default(null),
  session_id: z.string().nullable().optional().default(null),
  extra: z.record(z.unknown()).optional().default({}),
});

export const CronTaskSchema = z.object({
  task_id: z.string().min(1),
  name: z.string().optional().default(""),
  cron: z.string().min(1),
  task: z.string().min(1),
  team_name: z.string().min(1),
  entry_agent: z.string().nullable().optional().default(null),
  push_platform: PlatformTypeSchema.nullable().optional().default(null),
  push_chat_id: z.string().nullable().optional().default(null),
  enabled: z.boolean().optional().default(true),
  last_run: z.number().nullable().optional().default(null),
  next_run: z.number().nullable().optional().default(null),
  last_result: z.string().nullable().optional().default(null),
});

export const DaemonAgentConfigSchema = z.object({
  team_name: z.string().min(1),
  entry_agent: z.string().nullable().optional().default(null),
  session_id: z.string().nullable().optional().default(null),
  permissions: PermissionPolicySchema.optional().default({}),
  platforms: z.record(PlatformTypeSchema, PlatformConnectionSchema).optional().default({}),
  cron_tasks: z.array(CronTaskSchema).optional().default([]),
  heartbeat_interval: z.number().int().min(5).optional().default(30),
  enabled: z.boolean().optional().default(true),
});

export const DaemonSystemConfigSchema = z
  .object({
    enabled: z.boolean().optional().default(false),
    agents: z.array(DaemonAgentConfigSchema).optional().default([]),
    default_session_ttl: z.number().int().positive().optional().default(86400),
  })
  .superRefine((config, ctx) => {
    const used = new Map<string, string>();
    for (const agent of config.agents) {
      if (!agent.enabled) {
        continue;
      }
      for (const [platform, connection] of Object.entries(agent.platforms)) {
        if (!connection.enabled) {
          continue;
        }
        const existingTeam = used.get(platform);
        if (existingTeam && existingTeam !== agent.team_name) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["agents"],
            message: `平台 ${platform} 只能被一个已启用 team 占用，冲突 team: ${existingTeam}, ${agent.team_name}`,
          });
        }
        used.set(platform, agent.team_name);
      }
    }
  });

export const DaemonConfigUpdateSchema = DaemonSystemConfigSchema;

export const DaemonTestMessageSchema = z.object({
  content: z.string().optional().default("测试消息"),
  platform: PlatformTypeSchema.optional().default("feishu"),
  chat_id: z.string().optional().default("test_user"),
});

export const DaemonOutgoingMessageSchema = z.object({
  platform: PlatformTypeSchema,
  chat_id: z.string().min(1),
  content: z.string().min(1),
  message_type: z.string().optional().default("text"),
});

export const CronTaskUpdateSchema = CronTaskSchema.partial();

export type PlatformType = z.infer<typeof PlatformTypeSchema>;
export type PlatformConnection = z.infer<typeof PlatformConnectionSchema>;
export type CronTask = z.infer<typeof CronTaskSchema>;
export type DaemonAgentConfig = z.infer<typeof DaemonAgentConfigSchema>;
export type DaemonSystemConfig = z.infer<typeof DaemonSystemConfigSchema>;
export type DaemonTestMessage = z.infer<typeof DaemonTestMessageSchema>;
export type DaemonOutgoingMessage = z.infer<typeof DaemonOutgoingMessageSchema>;
export type CronTaskUpdate = z.infer<typeof CronTaskUpdateSchema>;
