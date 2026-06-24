/**
 * 后端事件契约：统一为 agent-protocol 的 Envelope 协议。
 *
 * 后端产出/消费的下行事件一律为 agent-protocol `Envelope`（17 种协议语义词 type + payload），
 * 旧 ClientEvent/ClientEventType/ClientToServerMessage 已彻底移除。上行（host→runtime）
 * 的合法帧由 ClientToServerEnvelopeSchema 校验（user_driven_change / abort / interaction(responded)）。
 *
 * 类型与运行时 schema 自 agent-protocol re-export，后端零重复定义；agent-protocol 保持零后端依赖。
 */
import { z } from "zod";

import {
  EnvelopeTypeSchema,
  type Envelope,
  type EnvelopeType,
  type ProtocolEnvelope,
  type RunStartedPayload,
  type RunEndedPayload,
  type AgentLifecyclePayload,
  type StreamOutputPayload,
  type StateSyncPayload,
  type ToolCallPayload,
  type ToolResultPayload,
  type InteractionPayload,
  type UserDrivenChangePayload,
  type AbortPayload,
  type AckPayload,
  type HeartbeatPayload,
  type ReconnectPayload,
  type ErrorPayload,
  type CapabilityManifestPayload,
  type HelloPayload,
  type InteractionKind,
  type RiskLevel,
  type AttachmentRef,
} from "@ragsystem/agent-protocol";

export type {
  Envelope,
  EnvelopeType,
  ProtocolEnvelope,
  RunStartedPayload,
  RunEndedPayload,
  AgentLifecyclePayload,
  StreamOutputPayload,
  StateSyncPayload,
  ToolCallPayload,
  ToolResultPayload,
  InteractionPayload,
  UserDrivenChangePayload,
  AbortPayload,
  AckPayload,
  HeartbeatPayload,
  ReconnectPayload,
  ErrorPayload,
  CapabilityManifestPayload,
  HelloPayload,
  InteractionKind,
  RiskLevel,
  AttachmentRef,
};

export { EnvelopeTypeSchema };

/* ============================================================
 * 上行 envelope（host → runtime）校验
 * ========================================================== */

const UplinkAttachmentRefSchema = z.object({
  file_id: z.string().min(1),
  original_name: z.string().nullable().optional(),
  stored_name: z.string().nullable().optional(),
  stored_path: z.string().nullable().optional(),
  mime: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  kind: z.string().nullable().optional(),
});

/**
 * 上行合法帧：用户驱动变更 / 取消 / 交互响应。
 * session.hello、heartbeat、capability_manifest 等握手/控制帧本期不强求，按需扩展。
 */
export const ClientToServerEnvelopeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("user_driven_change"),
    session_id: z.string().min(1),
    payload: z.object({
      category: z.enum(["task_submit", "message", "redirect", "env_notice"]),
      task: z.string().optional().default(""),
      selected_llm: z.string().optional(),
      attachments: z.array(UplinkAttachmentRefSchema).optional().default([]),
      request_id: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("abort"),
    session_id: z.string().min(1),
    payload: z
      .object({
        scope: z.literal("run"),
        reason: z.string().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("interaction"),
    session_id: z.string().min(1),
    call_id: z.string().min(1),
    payload: z.object({
      kind: z.enum(["approval", "user_input"]),
      phase: z.literal("responded"),
      approved: z.boolean().optional(),
      value: z.string().optional().default(""),
      message: z.string().optional().default(""),
    }),
  }),
]);

export type ClientToServerEnvelope = z.infer<typeof ClientToServerEnvelopeSchema>;
