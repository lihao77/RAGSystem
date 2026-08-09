import { z } from "zod";
import { ServerToClientEnvelopeSchema } from "@ragsystem/agent-protocol/wire";
import { MessageContentPartSchema } from "@ragsystem/agent-protocol";

export const PermissionModeSchema = z.enum(["strict", "standard", "relaxed", "dangerously_skip_permissions"]);
export const SessionOriginTypeSchema = z.enum(["direct", "bot", "widget"]);
export const SessionVisibilitySchema = z.enum(["private", "tenant"]);
export const SessionOriginChannelSchema = z.enum([
  "web",
  "api",
  "feishu",
  "cron",
  "widget_embed",
  "widget_api",
]);

export const CreateSessionRequestSchema = z.object({
  session_id: z.string().trim().min(1).nullable().optional(),
  team_name: z.string().trim().min(1).nullable().optional(),
  entry_agent_name: z.string().trim().min(1).nullable().optional(),
  permission_mode: PermissionModeSchema.nullable().optional(),
  workspace: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local_path"), root_path: z.string().trim().min(1) }).strict(),
    z.object({ kind: z.literal("existing"), workspace_id: z.string().trim().min(1) }).strict(),
  ]).nullable().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export const UpdateSessionPermissionModeRequestSchema = z.object({
  mode: PermissionModeSchema,
}).strict();

const SessionMetadataSchema = z.record(z.string(), z.unknown());

export const SessionOriginSchema = z.object({
  type: SessionOriginTypeSchema,
  id: z.string().min(1).nullable(),
  display_name: z.string(),
  channel: SessionOriginChannelSchema,
}).strict();

export const SessionWorkspaceSchema = z.object({
  workspace_id: z.string().min(1),
  display_name: z.string().min(1),
  root_path: z.string().nullable(),
}).strict();

export const CreatedSessionSchema = z.object({
  session_id: z.string().min(1),
  team_name: z.string().min(1),
  team_revision: z.string().min(1),
  entry_agent_name: z.string().min(1),
  owner_user_id: z.string().min(1).nullable(),
  visibility: SessionVisibilitySchema,
  origin: SessionOriginSchema,
  workspace: SessionWorkspaceSchema.nullable(),
  permission_mode: PermissionModeSchema.nullable(),
  metadata: SessionMetadataSchema,
}).strict();

export const SessionDetailSchema = CreatedSessionSchema.extend({
  tenant_id: z.string().min(1),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const SessionListItemSchema = z.object({
  session_id: z.string().min(1),
  title: z.string(),
  first_message: z.string(),
  last_message: z.string(),
  activity_at: z.string(),
  unread_count: z.number().int().nonnegative(),
  origin: SessionOriginSchema,
  workspace: SessionWorkspaceSchema.nullable(),
}).strict();

export const SessionListDataSchema = z.object({
  items: z.array(SessionListItemSchema),
  next_cursor: z.string().min(1).nullable(),
}).strict();

export const SessionListFacetsSchema = z.object({
  type_counts: z.object({
    direct: z.number().int().nonnegative(),
    bot: z.number().int().nonnegative(),
    widget: z.number().int().nonnegative(),
  }).strict(),
  origins: z.array(z.object({
    type: z.enum(["bot", "widget"]),
    id: z.string().min(1),
    display_name: z.string(),
    count: z.number().int().nonnegative(),
  }).strict()),
  workspaces: z.array(z.object({
    workspace_id: z.string().min(1),
    display_name: z.string().min(1),
    root_path: z.string().nullable(),
    count: z.number().int().nonnegative(),
  }).strict()),
}).strict();

export const WorkspaceListItemSchema = SessionWorkspaceSchema.extend({
  session_count: z.number().int().nonnegative(),
}).strict();
export const WorkspaceListDataSchema = z.object({
  items: z.array(WorkspaceListItemSchema),
}).strict();
export const CreateWorkspaceRequestSchema = z.object({
  root_path: z.string().trim().min(1),
}).strict();
export const WorkspaceResponseSchema = successResponseSchema(SessionWorkspaceSchema);

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
  content_parts: z.array(MessageContentPartSchema),
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
  outbox_watermark: z.number().int().nonnegative(),
}).strict();

export const SessionParticipantSchema = z.object({
  participant_id: z.string().min(1),
  parent_participant_id: z.string().min(1).nullable(),
  scope: z.enum(["root", "child"]),
  agent_name: z.string().min(1).nullable(),
  display_name: z.string().min(1),
  thread_key: z.string().min(1),
  lifecycle_status: z.string().min(1),
  last_run_id: z.string().min(1).nullable(),
  last_run_status: z.string().min(1).nullable(),
  created_at: z.string(),
  updated_at: z.string(),
}).strict();

export const SessionParticipantListDataSchema = z.object({
  items: z.array(SessionParticipantSchema),
  total: z.number().int().nonnegative(),
}).strict();

export const SessionMessageRunStepsDataSchema = z.object({
  message_id: z.string().min(1),
  items: z.array(ServerToClientEnvelopeSchema),
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean(),
}).strict();

export const SessionParticipantRunStepsDataSchema = z.object({
  participant_id: z.string().min(1),
  run_id: z.string().min(1),
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
export const SessionListFacetsResponseSchema = successResponseSchema(SessionListFacetsSchema);
export const WorkspaceListResponseSchema = successResponseSchema(WorkspaceListDataSchema);
export const SessionPermissionResponseSchema = successResponseSchema(SessionPermissionDataSchema);
export const SessionMessageListResponseSchema = successResponseSchema(SessionMessageListDataSchema);
export const SessionMessageRunStepsResponseSchema = successResponseSchema(SessionMessageRunStepsDataSchema);
export const SessionParticipantRunStepsResponseSchema = successResponseSchema(SessionParticipantRunStepsDataSchema);
export const SessionParticipantListResponseSchema = successResponseSchema(SessionParticipantListDataSchema);

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
export type SessionOriginType = z.infer<typeof SessionOriginTypeSchema>;
export type SessionVisibility = z.infer<typeof SessionVisibilitySchema>;
export type SessionOriginChannel = z.infer<typeof SessionOriginChannelSchema>;
export type SessionOrigin = z.infer<typeof SessionOriginSchema>;
export type SessionWorkspace = z.infer<typeof SessionWorkspaceSchema>;
export type UpdateSessionPermissionModeRequest = z.infer<typeof UpdateSessionPermissionModeRequestSchema>;
export type CreatedSession = z.infer<typeof CreatedSessionSchema>;
export type SessionDetail = z.infer<typeof SessionDetailSchema>;
export type SessionListItem = z.infer<typeof SessionListItemSchema>;
export type SessionListData = z.infer<typeof SessionListDataSchema>;
export type SessionListFacets = z.infer<typeof SessionListFacetsSchema>;
export type SessionPermissionData = z.infer<typeof SessionPermissionDataSchema>;
export type SessionMessageToolCall = z.infer<typeof SessionMessageToolCallSchema>;
export type SessionMessage = z.infer<typeof SessionMessageSchema>;
export type SessionMessageListData = z.infer<typeof SessionMessageListDataSchema>;
export type SessionMessageRunStepsData = z.infer<typeof SessionMessageRunStepsDataSchema>;
export type SessionParticipantRunStepsData = z.infer<typeof SessionParticipantRunStepsDataSchema>;
export type SessionParticipant = z.infer<typeof SessionParticipantSchema>;
export type SessionParticipantListData = z.infer<typeof SessionParticipantListDataSchema>;
export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>;
export type SessionDetailResponse = z.infer<typeof SessionDetailResponseSchema>;
export type SessionListResponse = z.infer<typeof SessionListResponseSchema>;
export type SessionListFacetsResponse = z.infer<typeof SessionListFacetsResponseSchema>;
export type WorkspaceListItem = z.infer<typeof WorkspaceListItemSchema>;
export type WorkspaceListResponse = z.infer<typeof WorkspaceListResponseSchema>;
export type CreateWorkspaceRequest = z.infer<typeof CreateWorkspaceRequestSchema>;
export type WorkspaceResponse = z.infer<typeof WorkspaceResponseSchema>;
export type SessionPermissionResponse = z.infer<typeof SessionPermissionResponseSchema>;
export type SessionMessageListResponse = z.infer<typeof SessionMessageListResponseSchema>;
export type SessionMessageRunStepsResponse = z.infer<typeof SessionMessageRunStepsResponseSchema>;
export type SessionParticipantRunStepsResponse = z.infer<typeof SessionParticipantRunStepsResponseSchema>;
export type SessionParticipantListResponse = z.infer<typeof SessionParticipantListResponseSchema>;
export type SessionWsTicketData = z.infer<typeof SessionWsTicketDataSchema>;
export type SessionWsTicketResponse = z.infer<typeof SessionWsTicketResponseSchema>;
