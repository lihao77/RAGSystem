import { z } from "zod";

import { InteractionRespondMessageSchema } from "./interactions.js";

export const ClientEventTypeSchema = z.enum([
  "heartbeat",
  "error",
  "reconnect_start",
  "reconnect_end",
  "send.ack",
  "send.error",
  "stop.ack",
  "approve.error",
  "interaction.ack",
  "interaction.error",
  "user_input.ack",
  "user_input.error",
  "session.run_started",
  "run.start",
  "run.end",
  "session.updated",
  "command.result",
  "execution.step",
  "agent.start",
  "agent.end",
  "agent.error",
  "agent.intent_delta",
  "agent.intent_complete",
  "call.agent.start",
  "call.agent.end",
  "context.usage",
  "context.compression_start",
  "context.compression_summary",
  "llm.first_token",
  "output.chunk",
  "output.final_answer",
  "output.message_saved",
  "interaction.required",
  "user.approval_required",
  "user.approval_granted",
  "user.approval_denied",
  "user.input_required",
  "user.interrupt",
]);

export type ClientEventType = z.infer<typeof ClientEventTypeSchema>;

export interface ClientEvent {
  type: ClientEventType | string;
  session_id?: string;
  run_id?: string;
  stream_seq?: number;
  event_id?: string;
  event_seq?: number;
  timestamp?: number | string;
  data?: unknown;
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
  InteractionRespondMessageSchema,
  z.object({
    type: z.literal("user_input"),
    input_id: z.string(),
    value: z.string().optional().default(""),
  }),
]);

export type ClientToServerMessage = z.infer<typeof ClientToServerMessageSchema>;
