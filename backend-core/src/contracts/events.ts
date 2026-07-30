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
  ClientToServerEnvelopeSchema,
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
  type SessionRuntimePayload,
  type SessionRuntimeState,
  type SessionRuntimeAction,
  type SessionLoadStrategy,
  type ErrorPayload,
  type CapabilityManifestPayload,
  type HelloPayload,
  type InteractionKind,
  type RiskLevel,
  type AttachmentRef,
  type DelegatedToolDeclaration,
  type ToolsRegisterPayload,
  DelegatedToolDeclarationSchema,
  SessionRuntimePayloadSchema,
  SESSION_LOAD_STRATEGY_BY_STATE,
  sessionLoadStrategyRestoresActiveRun,
} from "@ragsystem/agent-protocol/wire";

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
  SessionRuntimePayload,
  SessionRuntimeState,
  SessionRuntimeAction,
  SessionLoadStrategy,
  ErrorPayload,
  CapabilityManifestPayload,
  HelloPayload,
  InteractionKind,
  RiskLevel,
  AttachmentRef,
  DelegatedToolDeclaration,
  ToolsRegisterPayload,
};

export {
  EnvelopeTypeSchema,
  DelegatedToolDeclarationSchema,
  SessionRuntimePayloadSchema,
  ClientToServerEnvelopeSchema,
  SESSION_LOAD_STRATEGY_BY_STATE,
  sessionLoadStrategyRestoresActiveRun,
};

/* ============================================================
 * 上行 envelope（host → runtime）校验
 * ========================================================== */

/**
 * 上行合法帧：用户驱动变更 / 取消 / 交互响应。
 * session.hello、heartbeat、capability_manifest 等握手/控制帧本期不强求，按需扩展。
 */
export type ClientToServerEnvelope = import("@ragsystem/agent-protocol/wire").ClientToServerEnvelope;

/** DelegatedToolDeclaration 的 wire 类型（z.infer，exactOptionalPropertyTypes 下与 schema 一致）。backend 内部存取用。 */
export type DelegatedToolDeclarationWire = z.infer<typeof DelegatedToolDeclarationSchema>;
