import { z } from "zod";

import { PlatformTypeSchema } from "../control-plane/bot.js";

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

export type DaemonTestMessage = z.infer<typeof DaemonTestMessageSchema>;
export type DaemonOutgoingMessage = z.infer<typeof DaemonOutgoingMessageSchema>;
