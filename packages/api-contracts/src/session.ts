import { z } from "zod";
import { ServerToClientEnvelopeSchema } from "@ragsystem/agent-protocol/wire";

export const PermissionModeSchema = z.enum(["strict", "standard", "relaxed", "dangerously_skip_permissions"]);

export const CreateSessionRequestSchema = z.object({
  session_id: z.string().trim().min(1).nullable().optional(),
  permission_mode: PermissionModeSchema.nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const UpdateSessionPermissionModeRequestSchema = z.object({
  mode: PermissionModeSchema,
}).strict();

const SessionMetadataSchema = z.record(z.string(), z.unknown());

export const CreatedSessionSchema = z.object({
  session_id: z.string().min(1),
  user_id: z.string().min(1).nullable(),
  permission_mode: PermissionModeSchema.nullable(),
  metadata: SessionMetadataSchema,
}).strict();

export const SessionDetailSchema = CreatedSessionSchema.extend({
  tenant_id: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const SessionListItemSchema = SessionDetailSchema.extend({
  title: z.string(),
  last_message: z.string(),
  last_message_at: z.string(),
  first_message: z.string(),
  unread_count: z.number().int().nonnegative(),
}).strict();

export const SessionListDataSchema = z.object({
  items: z.array(SessionListItemSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
}).strict();

export const SessionPermissionDataSchema = z.object({
  mode: PermissionModeSchema,
}).strict();

export const SessionMessageToolCallSchema = z.object({
  id: z.string().min(1),
  type: z.literal("function"),
  function: z.object({
    name: z.string(),
    arguments: z.string(),
  }).strict(),
}).strict();

export const SessionMessageSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  session_id: z.string().min(1),
  role: z.enum(["system", "user", "assistant", "tool"]),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: z.string(),
  thread_key: z.string(),
  child_agent_id: z.string().nullable(),
  tool_calls: z.array(SessionMessageToolCallSchema).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
  has_execution: z.boolean().optional(),
}).strict();

export const SessionMessageListDataSchema = z.object({
  items: z.array(SessionMessageSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
}).strict();

export const SessionMessageRunStepsDataSchema = z.object({
  message_id: z.string().min(1),
  items: z.array(ServerToClientEnvelopeSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
}).strict();

function successResponseSchema<T extends z.ZodTypeAny>(data: T) {
  return z.object({
    success: z.literal(true),
    message: z.string(),
    data,
  }).strict();
}

export const CreateSessionResponseSchema = successResponseSchema(CreatedSessionSchema);
export const SessionDetailResponseSchema = successResponseSchema(SessionDetailSchema);
export const SessionListResponseSchema = successResponseSchema(SessionListDataSchema);
export const SessionPermissionResponseSchema = successResponseSchema(SessionPermissionDataSchema);
export const SessionMessageListResponseSchema = successResponseSchema(SessionMessageListDataSchema);
export const SessionMessageRunStepsResponseSchema = successResponseSchema(SessionMessageRunStepsDataSchema);

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
export type PermissionMode = z.infer<typeof PermissionModeSchema>;
export type UpdateSessionPermissionModeRequest = z.infer<typeof UpdateSessionPermissionModeRequestSchema>;
export type CreatedSession = z.infer<typeof CreatedSessionSchema>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
export type SessionListData = z.infer<typeof SessionListDataSchema>;
export type SessionPermissionData = z.infer<typeof SessionPermissionDataSchema>;
export type SessionMessageToolCall = z.infer<typeof SessionMessageToolCallSchema>;
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export type SessionMessageListData = z.infer<typeof SessionMessageListDataSchema>;
export type SessionMessageRunStepsData = z.infer<typeof SessionMessageRunStepsDataSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type SessionDetailResponse = z.infer<typeof SessionDetailResponseSchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SessionPermissionResponse = z.infer<typeof SessionPermissionResponseSchema>;
export type SessionMessageListResponse = z.infer<typeof SessionMessageListResponseSchema>;
export type SessionMessageRunStepsResponse = z.infer<typeof SessionMessageRunStepsResponseSchema>;
export type SessionWsTicketData = z.infer<typeof SessionWsTicketDataSchema>;
export type SessionWsTicketResponse = z.infer<typeof SessionWsTicketResponseSchema>;
