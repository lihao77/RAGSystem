import { z } from "zod";

export const ClientEventTypeSchema = z.enum([
  "heartbeat",
  "error",
  "reconnect_start",
  "reconnect_end",
  "send.ack",
  "send.error",
  "stop.ack",
  "approve.error",
  "user_input.error",
  "run.start",
  "run.end",
  "session.updated",
  "command.result",
  "execution.step",
  "user.approval_required",
  "user.input_required",
]);

export type ClientEventType = z.infer<typeof ClientEventTypeSchema>;

export interface ClientEvent {
  type: ClientEventType | string;
  session_id?: string;
  run_id?: string;
  stream_seq?: number;
  timestamp?: number | string;
  content?: unknown;
  error?: string;
  [key: string]: unknown;
}

export const ClientToServerMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("send"),
    task: z.string().optional().default(""),
    user_id: z.string().optional(),
    selected_llm: z.string().optional(),
    attachments: z.array(z.unknown()).optional().default([]),
    request_id: z.string().optional(),
  }),
  z.object({
    type: z.literal("stop"),
  }),
  z.object({
    type: z.literal("approve"),
    approval_id: z.string(),
    approved: z.boolean(),
    message: z.string().optional().default(""),
  }),
  z.object({
    type: z.literal("user_input"),
    input_id: z.string(),
    value: z.string().optional().default(""),
  }),
]);

export type ClientToServerMessage = z.infer<typeof ClientToServerMessageSchema>;
