import { z } from "zod";

export const SessionMetadataSchema = z.record(z.string(), z.unknown()).default({});

export const CreateSessionRequestSchema = z.object({
  session_id: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
  metadata: SessionMetadataSchema.optional().default({}),
});

export const UpdateMessageRequestSchema = z.object({
  content: z.string(),
});

export const RollbackRequestSchema = z.object({
  after_seq: z.number().int().nullable().optional(),
  after_message_id: z.string().nullable().optional(),
});

export const RecoverSessionRequestSchema = z.object({
  checkpoint_id: z.string().nullable().optional(),
  agent_name: z.string().nullable().optional(),
  user_id: z.string().nullable().optional(),
});

export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;
export type UpdateMessageRequest = z.infer<typeof UpdateMessageRequestSchema>;
export type RollbackRequest = z.infer<typeof RollbackRequestSchema>;
export type RecoverSessionRequest = z.infer<typeof RecoverSessionRequestSchema>;

export interface SessionInfo {
  session_id: string;
  user_id: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SessionListItem extends SessionInfo {
  title: string;
  last_message: string;
  last_message_at: string;
  first_message: string;
  unread_count: number;
}

export interface MessageInfo {
  id: string;
  seq: number;
  session_id: string;
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  metadata: Record<string, unknown>;
  created_at: string;
  thread_key: string;
  child_agent_id: string | null;
  has_execution?: boolean;
  execution_steps?: Record<string, unknown>[];
}
