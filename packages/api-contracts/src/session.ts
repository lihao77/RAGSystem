import { z } from "zod";

export const PermissionModeSchema = z.enum(["strict", "standard", "relaxed", "dangerously_skip_permissions"]);

export const CreateSessionRequestSchema = z.object({
  session_id: z.string().trim().min(1).nullable().optional(),
  permission_mode: PermissionModeSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const UpdateSessionPermissionModeRequestSchema = z.object({
  mode: PermissionModeSchema,
}).strict();

export const SessionWsTicketDataSchema = z.object({
  ticket: z.string().min(1),
  expires_at: z.number().int().positive(),
}).strict();

export const SessionWsTicketResponseSchema = z.object({
  success: z.literal(true),
  message: z.string(),
  data: SessionWsTicketDataSchema,
}).strict();

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateSessionPermissionModeRequest = z.infer<typeof UpdateSessionPermissionModeRequestSchema>;
export type SessionWsTicketData = z.infer<typeof SessionWsTicketDataSchema>;
export type SessionWsTicketResponse = z.infer<typeof SessionWsTicketResponseSchema>;
