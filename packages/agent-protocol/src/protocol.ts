/**
 * Agent 通信协议 envelope —— agent-protocol 协议面（步骤三固化版）。
 *
 * 设计基线：
 *   • 顶层仅协议语义词（传输/会话/调用/序号/时间），业务值下沉 payload。
 *   • session.hello 握手锁定 protocol_version + protocol/capabilities 两个独立扩展点。
 *   • 投影用 tool_call/tool_result（纯通知，落 outbox 回放）；委托用 delegate_call/delegate_result（执行指令/回传，realtime 不回放）。
 *   • 交互收敛为单一 interaction type；legacy 双发由 adapter 层屏蔽（协议不复制债务）。
 *
 * backend-ts/contracts/events.ts re-export 本包 Envelope（后端零重复定义）；后端 kernel 产 runtime.* 事件经 event-publisher 翻译为 Envelope。
 * 本文件不 import backend-ts/contracts —— agent-protocol 保持零后端依赖。
 */
import { z } from "zod";

/* ============================================================
 * 一、Envelope 顶层
 * ========================================================== */

export const PROTOCOL_VERSION = "1.0" as const;
export type ProtocolVersion = typeof PROTOCOL_VERSION;

export const EnvelopeTypeSchema = z.enum([
  "session.hello",
  "session.runtime",
  "heartbeat",
  "session.reconnect",
  "error",
  "run_started",
  "run_ended",
  "agent_started",
  "agent_ended",
  "model_request",
  "model_attempt_started",
  "model_attempt_failed",
  "model_attempt_completed",
  "stream_output",
  "state_sync",
  "tool_call",
  "tool_result",
  "agent_message",
  "delegate_call",
  "delegate_result",
  "tools.register",
  "interaction",
  "resume",
  "user_driven_change",
  "abort",
  "capability_manifest",
  "ack",
]);
export type EnvelopeType = z.infer<typeof EnvelopeTypeSchema>;

export type ProtocolEnvelope = z.infer<typeof ProtocolEnvelopeSchema>;

/** 线协议信封的通用类型别名（供 SDK 门面引用）。 */
export type Envelope = ProtocolEnvelope;

/* ============================================================
 * 二、两个独立扩展点（互不嵌套、各自带扩展槽）
 * ========================================================== */

/** 扩展点 A：protocol —— agent 输出格式解析适配维度。 */
export type ProtocolDescriptor = z.infer<typeof ProtocolDescriptorSchema>;

/** 扩展点 B：capabilities —— 工具白名单 + 权限分级维度。 */
export type CapabilityDescriptor = z.infer<typeof CapabilityDescriptorSchema>;

export type ToolAllowance = z.infer<typeof ToolAllowanceSchema>;

/* ============================================================
 * 三、内联复用类型（避免 agent-protocol 依赖 backend-ts/contracts）
 * ========================================================== */

export type InteractionKind = "approval" | "user_input";
export type RiskLevel = "low" | "medium" | "high";

/**
 * 委托宿主（前端）执行的工具声明——可序列化。
 * 握手期 tools.register 的载体 + 后端 HostToolRegistry 存储；不含 execute（执行在前端）。
 * 宿主侧 TS API（含 execute）见 agent-client.ts DelegatedToolSpec；二者经前端序列化映射。
 */
export type DelegatedToolDeclaration = z.infer<
  typeof DelegatedToolDeclarationSchema
>;

/** 客户端选择的会话附件。服务端只信任 file_id，其余元数据必须重新解析。 */
export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
/** 服务端解析后的会话附件快照。 */
export type MessageAttachment = z.infer<typeof MessageAttachmentSchema>;

/* ============================================================
 * 四、各 type 的 payload
 * ========================================================== */

/* —— 控制帧 —— */
export type HelloPayload = z.infer<typeof HelloPayloadSchema>;
export type HeartbeatPayload = z.infer<typeof HeartbeatPayloadSchema>;
export type ReconnectPayload = z.infer<typeof ReconnectPayloadSchema>;
export type SessionRuntimePayload = z.infer<typeof SessionRuntimePayloadSchema>;
export type SessionRuntimeState = z.infer<typeof SessionRuntimeStateSchema>;
export type SessionRuntimeAction = z.infer<typeof SessionRuntimeActionSchema>;
export type SessionLoadStrategy = z.infer<typeof SessionLoadStrategySchema>;
export type ErrorPayload = z.infer<typeof ErrorPayloadSchema>;
export type AckPayload = z.infer<typeof AckPayloadSchema>;

/* —— 生命周期帧 —— */
export type RunStartedPayload = z.infer<typeof RunStartedPayloadSchema>;
export type RunEndedPayload = z.infer<typeof RunEndedPayloadSchema>;
export type AgentStartedPayload = z.infer<typeof AgentStartedPayloadSchema>;
export type AgentEndedPayload = z.infer<typeof AgentEndedPayloadSchema>;
export type AgentLifecyclePayload = z.infer<typeof AgentLifecyclePayloadSchema>;

/* —— 内容流 —— */
export type ModelRequestPayload = z.infer<typeof ModelRequestPayloadSchema>;
export type ModelAttemptStartedPayload = z.infer<typeof ModelAttemptStartedPayloadSchema>;
export type ModelAttemptFailedPayload = z.infer<typeof ModelAttemptFailedPayloadSchema>;
export type ModelAttemptCompletedPayload = z.infer<typeof ModelAttemptCompletedPayloadSchema>;
export type StreamOutputPayload = z.infer<typeof StreamOutputPayloadSchema>;
export type AssistantContentPart = z.infer<typeof AssistantContentPartSchema>;
export type MessageContentPart = z.infer<typeof MessageContentPartSchema>;

/**
 * 状态同步：外部状态已变更，请对齐本地视图。
 * detail 透传 unknown：command_result / compression 等宿主侧语义不强制 schema。
 */
export type StateSyncPayload = z.infer<typeof StateSyncPayloadSchema>;

/* —— 工具帧（投影通知，后端本地执行） —— */
export type ToolCallPayload = z.infer<typeof ToolCallPayloadSchema>;
export type ToolResultPayload = z.infer<typeof ToolResultPayloadSchema>;
export type AgentOperation = z.infer<typeof AgentOperationSchema>;
export type AgentMessagePayload = z.infer<typeof AgentMessagePayloadSchema>;
export type ToolFileRef = z.infer<typeof ToolFileRefSchema>;

/* —— 委托帧（宿主执行，独立语义） —— */
/** 委托执行指令（后端→前端）：gate 通过后驱动宿主执行。独立于 tool_call（纯通知）。 */
export type DelegateCallPayload = z.infer<typeof DelegateCallPayloadSchema>;
/** 委托执行回传（前端→后端）：宿主执行结果，resolve 委托等待器。 */
export type DelegateResultPayload = z.infer<typeof DelegateResultPayloadSchema>;

/** tools.register 上行 payload：宿主声明本连接可委托执行的工具清单。 */
export type ToolsRegisterPayload = z.infer<typeof ToolsRegisterPayloadSchema>;

/* —— 交互（单一 type，legacy 双发由 adapter 屏蔽） —— */
export type InteractionPayload = z.infer<typeof InteractionPayloadSchema>;

/* —— 用户驱动 / 取消 / 能力 —— */
export type UserDrivenChangePayload = z.infer<typeof UserDrivenChangePayloadSchema>;
export type AbortPayload = z.infer<typeof AbortPayloadSchema>;
export type CapabilityManifestPayload = z.infer<typeof CapabilityManifestPayloadSchema>;

/* ============================================================
 * 五、zod validator
 * ========================================================== */

export const ProtocolDescriptorSchema = z.object({
  output: z.enum(["xml_intent", "native_function_call", "hybrid"]),
  intent_tag_enabled: z.boolean().optional(),
  function_call_mode: z.enum(["auto", "required", "none"]).optional(),
  streaming_framing: z.enum(["token", "sentence", "block"]).optional(),
});

export const ToolAllowanceSchema = z.object({
  name: z.string().min(1),
  risk_level: z.enum(["low", "medium", "high"]).optional(),
  host_executed: z.boolean().optional(),
});

export const CapabilityDescriptorSchema = z.object({
  tools: z.array(ToolAllowanceSchema),
  risk_policy: z.object({
    low: z.enum(["auto", "notify"]),
    medium: z.enum(["notify", "require_approval"]),
    high: z.enum(["require_approval", "deny"]),
  }),
  delegated_tools: z.array(z.string()).optional(),
});

/** 委托工具声明 zod（tools.register 上行校验；对齐 DelegatedToolDeclaration）。 */
export const DelegatedToolDeclarationSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  input_schema: z.record(z.unknown()),
  risk_level: z.enum(["low", "medium", "high"]).optional(),
  read_only: z.boolean().optional(),
  cancellable: z.boolean().optional(),
});

export const AttachmentRefSchema = z.object({
  file_id: z.string().min(1),
}).strict();

export const MessageAttachmentSchema = z.object({
  file_id: z.string().min(1),
  original_name: z.string().min(1),
  stored_name: z.string().min(1),
  mime: z.string(),
  size: z.number().int().nonnegative(),
  kind: z.enum(["image", "file"]),
  file_path: z.string().min(1).optional(),
  file_path_space: z.enum(["uploads", "absolute"]).optional(),
}).strict();

export const HelloPayloadSchema = z.object({
  role: z.enum(["host", "agent-runtime"]),
  protocol: ProtocolDescriptorSchema,
  capabilities: CapabilityDescriptorSchema,
});

export const HeartbeatPayloadSchema = z.object({
  last_seq: z.number().int().nonnegative().optional(),
});

export const ReconnectPayloadSchema = z.object({
  phase: z.enum(["start", "end"]),
  replay_count: z.number().int().nonnegative().optional(),
  replay_source: z.enum(["durable_outbox", "active_run_snapshot", "memory"]).optional(),
});

export const ErrorPayloadSchema = z.object({
  code: z.string().min(1),
  message: z.string(),
  ref_call_id: z.string().optional(),
});

export const AckPayloadSchema = z.object({
  ref_message_id: z.string().optional(),
  ref_call_id: z.string().optional(),
  request_id: z.string().optional(),
  category: z.enum(["send", "stop", "interaction", "resume", "tool_delegate"]),
  ok: z.boolean(),
  kind: z.enum(["agent_run", "command"]).optional(),
  error: z.string().optional(),
});

export const RunStartedPayloadSchema = z.object({
  request_id: z.string().optional(),
  task: z.string().optional(),
  source: z.string().optional(),
});

export const RunEndedPayloadSchema = z.object({
  status: z.enum(["completed", "failed", "interrupted", "suspended"]),
  reason: z.string().optional(),
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

export const ModelRequestPayloadSchema = z.object({
  phase: z.literal("start"),
  round: z.number().int().nonnegative(),
  /** 当前 agent 的父调用；子 agent 模型请求不影响 root 消息状态。 */
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

const ModelAttemptPayloadBaseSchema = z.object({
  attempt_id: z.string().min(1),
  attempt: z.number().int().positive(),
  max_attempts: z.number().int().positive(),
  round: z.number().int().nonnegative(),
  provider: z.string().min(1),
  model: z.string().min(1),
  /** 当前 agent 的父调用；用于并发子 agent 活动投影。 */
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

export const ModelAttemptStartedPayloadSchema = ModelAttemptPayloadBaseSchema.extend({
  phase: z.literal("start"),
});

export const ModelAttemptFailedPayloadSchema = ModelAttemptPayloadBaseSchema.extend({
  phase: z.literal("failed"),
  will_retry: z.boolean(),
  retry_delay_ms: z.number().nonnegative().optional(),
  elapsed_ms: z.number().nonnegative(),
  error: z.string(),
});

export const ModelAttemptCompletedPayloadSchema = ModelAttemptPayloadBaseSchema.extend({
  phase: z.literal("end"),
  elapsed_ms: z.number().nonnegative(),
});

export const AssistantContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal("file_ref"),
    file_path: z.string().min(1),
    presentation: z.enum(["inline", "attachment", "preview"]),
    caption: z.string().min(1).optional(),
  }).strict(),
]);

export const CommandResolutionSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("prompt"),
    agent_text: z.string().min(1),
    snapshot_id: z.string().min(1),
  }).strict(),
  z.object({
    kind: z.literal("system"),
  }).strict(),
]);

/** Canonical message content shared by history APIs, clients, and agent context. */
export const MessageContentPartSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("text"),
    text: z.string(),
  }).strict(),
  z.object({
    type: z.literal("file_ref"),
    file_path: z.string().min(1),
    presentation: z.enum(["inline", "attachment", "preview"]),
    caption: z.string().min(1).optional(),
    media_type: z.string().min(1).optional(),
    size: z.number().int().nonnegative().optional(),
  }).strict(),
  z.object({
    type: z.literal("attachment_ref"),
    file_id: z.string().min(1),
    original_name: z.string().min(1),
    stored_name: z.string().min(1),
    mime: z.string(),
    size: z.number().int().nonnegative(),
    kind: z.enum(["image", "file"]),
    presentation: z.enum(["inline", "attachment", "preview"]),
    file_path: z.string().min(1).optional(),
    file_path_space: z.enum(["uploads", "absolute"]).optional(),
  }).strict(),
  z.object({
    type: z.literal("command_ref"),
    invocation_id: z.string().min(1),
    name: z.string().min(1),
    args: z.string(),
    raw_text: z.string().min(1),
    resolution: CommandResolutionSchema,
  }).strict(),
  z.object({
    type: z.literal("command_result"),
    invocation_id: z.string().min(1),
    name: z.string().min(1),
    success: z.boolean(),
    text: z.string(),
    error: z.string().min(1).optional(),
  }).strict(),
]);

export const StreamOutputPayloadSchema = z.object({
  phase: z.enum([
    "first_token",
    "delta",
    "part_added",
    "final",
    "intent_delta",
    "intent_complete",
  ]),
  content: z.string().optional(),
  part_index: z.number().int().nonnegative().optional(),
  part: AssistantContentPartSchema.optional(),
  /** Ordered rich content for clients that can render workspace file references. */
  content_parts: z.array(AssistantContentPartSchema).optional(),
  elapsed_ms: z.number().nonnegative().optional(),
  round: z.number().int().nonnegative().optional(),
  /** 当前 agent 的父调用；子 agent 输出据此归入父执行树，而不是 root 文本流。 */
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

export const StateSyncPayloadSchema = z.object({
  category: z.enum([
    "message_saved",
    "session_updated",
    "context_usage",
    "compression",
    "command_result",
  ]),
  ref: z
    .object({
      message_id: z.string().optional(),
      seq: z.number().int().nonnegative().optional(),
      role: z.string().optional(),
      request_id: z.string().optional(),
      /** Server-confirmed execution round for a run-injected user message. */
      round_index: z.number().int().nonnegative().optional(),
      /** Canonical persisted message content, used to reconcile optimistic client state. */
      content_parts: z.array(MessageContentPartSchema).optional(),
      /** Canonical message metadata used to bind the visible input to its consuming Run. */
      metadata: z.record(z.unknown()).optional(),
    })
    .optional(),
  metrics: z.record(z.number()).optional(),
  detail: z.unknown().optional(),
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

export const ToolCallPayloadSchema = z.object({
  tool: z.string().min(1),
  input: z.unknown().optional(),
  phase: z.literal("start"),
  status: z.literal("running").optional(),
  round: z.number().int().nonnegative().optional(),
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

export const ToolFileRefSchema = z.object({
  file_type: z.enum(["json", "text", "image"]),
  path: z.string().min(1),
  media_type: z.string().min(1),
  size: z.number().int().nonnegative(),
  metadata: z.record(z.unknown()),
}).strict();

export const AgentOperationSchema = z.object({
  type: z.enum(["create_child", "resume_child", "message_child", "message_parent"]),
  agent_name: z.string().min(1).optional(),
  child_agent_id: z.string().min(1).optional(),
  run_id: z.string().min(1).optional(),
  background_task_id: z.string().min(1).optional(),
  message_id: z.string().min(1).optional(),
  message_kind: z.enum(["progress", "request", "response", "result"]).optional(),
  delivery_status: z.enum(["queued"]).optional(),
}).strict();

export const ToolResultPayloadSchema = z
  .object({
    tool: z.string().min(1),
    phase: z.literal("end"),
    ok: z.boolean(),
    status: z.enum(["succeeded", "failed", "interrupted"]),
    observation: z.string().optional(),
    summary: z.string().optional(),
    files: z.array(ToolFileRefSchema).optional(),
    agent_operation: AgentOperationSchema.optional(),
    elapsed_ms: z.number().nonnegative().optional(),
    approval: z
      .object({
        status: z.enum(["pending", "granted", "denied"]),
        message: z.string().optional(),
      })
      .optional(),
    lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
  })
  .superRefine((payload, ctx) => {
    const valid = payload.ok
      ? payload.status === "succeeded"
      : payload.status === "failed" || payload.status === "interrupted";
    if (!valid) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["status"],
        message: payload.ok
          ? "status must be succeeded when ok is true"
          : "status must be failed or interrupted when ok is false",
      });
    }
  });

export const AgentMessagePayloadSchema = z.object({
  kind: z.enum(["progress", "request", "response", "result"]),
  message_id: z.string().min(1),
  /** Canonical messages.seq; distinct from mailbox and envelope delivery sequences. */
  seq: z.number().int().nonnegative().optional(),
  source_run_id: z.string().nullable().optional(),
  source_agent_call_id: z.string().nullable().optional(),
  source_agent_name: z.string().min(1).optional(),
  source_child_agent_id: z.string().nullable().optional(),
  target_run_id: z.string().nullable().optional(),
  target_agent_call_id: z.string().nullable().optional(),
  target_child_agent_id: z.string().nullable().optional(),
  target_thread_key: z.string().min(1).optional(),
  target_parent_call_id: z.string().nullable().optional(),
  target_parent_agent_call_id: z.string().nullable().optional(),
  target_root_run_id: z.string().nullable().optional(),
  target_agent_name: z.string().min(1).optional(),
  direction: z.enum(["parent_to_child", "child_to_parent"]).optional(),
  correlation_id: z.string().nullable().optional(),
  reply_to_message_id: z.string().nullable().optional(),
  content: z.string().optional(),
  content_parts: z.array(MessageContentPartSchema).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const DelegateCallPayloadSchema = z.object({
  tool: z.string().min(1),
  input: z.unknown().optional(),
  phase: z.literal("request"),
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

export const DelegateResultPayloadSchema = z.object({
  phase: z.literal("result"),
  ok: z.boolean(),
  observation: z.string().optional(),
  error: z.string().optional(),
  elapsed_ms: z.number().optional(),
});

export const ToolsRegisterPayloadSchema = z.object({
  tools: z.array(DelegatedToolDeclarationSchema),
});

export const InteractionPayloadSchema = z.object({
  kind: z.enum(["approval", "user_input"]),
  phase: z.enum(["required", "responded"]),
  tool: z.string().optional(),
  input: z.unknown().optional(),
  prompt: z.string().optional(),
  risk_level: z.enum(["low", "medium", "high"]).optional(),
  approved: z.boolean().optional(),
  value: z.string().optional(),
  message: z.string().optional(),
});

export const SessionRuntimeStateSchema = z.enum([
  "idle",
  "running",
  "waiting_interaction",
  "suspended",
  "resuming",
  "maintenance",
]);

export const SessionRuntimeActionSchema = z.enum([
  "send_message",
  "send_followup",
  "stop_run",
  "respond_interaction",
  "resume_run",
  "start_maintenance",
]);

export const SessionLoadStrategySchema = z.enum([
  "history",
  "attach_run",
  "attach_run_and_present_interactions",
  "restore_suspended_run_and_present_interactions",
  "attach_resume",
  "watch_maintenance",
]);

export const SESSION_LOAD_STRATEGY_BY_STATE = {
  idle: "history",
  running: "attach_run",
  waiting_interaction: "attach_run_and_present_interactions",
  suspended: "restore_suspended_run_and_present_interactions",
  resuming: "attach_resume",
  maintenance: "watch_maintenance",
} as const satisfies Record<SessionRuntimeState, SessionLoadStrategy>;

/** 初次加载时需要恢复 active run 执行树的策略。 */
export function sessionLoadStrategyRestoresActiveRun(strategy: SessionLoadStrategy): boolean {
  return strategy === "attach_run"
    || strategy === "attach_run_and_present_interactions"
    || strategy === "restore_suspended_run_and_present_interactions"
    || strategy === "attach_resume";
}

export const SessionRuntimeActiveRunSchema = z.object({
  run_id: z.string().min(1),
  status: z.enum(["running", "waiting_interaction", "suspended", "resuming"]),
  execution_owner: z.enum(["attached", "remote", "detached"]),
  task: z.string(),
  request_id: z.string().nullable(),
  execution_kind: z.string(),
  started_at: z.string(),
  updated_at: z.string(),
  activity: z.object({
    models: z.array(z.object({
      call_id: z.string().min(1),
      agent_id: z.string(),
      round: z.number().int().nonnegative(),
      status: z.enum(["requested", "waiting", "streaming", "retry_wait", "failed"]),
      attempt_id: z.string().min(1).nullable(),
      attempt: z.number().int().positive().nullable(),
      max_attempts: z.number().int().positive().nullable(),
      provider: z.string().nullable(),
      model: z.string().nullable(),
      started_at: z.string().nullable(),
      retry_at: z.string().nullable(),
      error: z.string().nullable(),
      updated_at: z.string(),
    })),
    tools: z.array(z.object({
      call_id: z.string().min(1),
      agent_id: z.string(),
      parent_call_id: z.string().min(1).optional(),
      tool: z.string(),
      started_at: z.string(),
    })),
    updated_at: z.string(),
  }),
});

export const SessionRuntimeLastRunSchema = z.object({
  run_id: z.string().min(1),
  status: z.enum(["completed", "failed", "interrupted"]),
  task: z.string(),
  reason: z.string().nullable(),
  started_at: z.string(),
  finished_at: z.string(),
});

export const SessionPendingInteractionSchema = z.object({
  interaction_id: z.string().min(1),
  run_id: z.string().min(1),
  root_run_id: z.string().min(1),
  batch_id: z.string().min(1),
  kind: z.enum(["approval", "user_input"]),
  status: z.enum(["waiting", "suspended"]),
  requested_at: z.string(),
  payload: InteractionPayloadSchema.extend({ phase: z.literal("required") }),
}).superRefine((interaction, context) => {
  if (interaction.kind !== interaction.payload.kind) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["payload", "kind"],
      message: "payload.kind must match interaction kind",
    });
  }
});

export const SessionRuntimeMaintenanceSchema = z.object({
  kind: z.enum(["rollback", "compact"]),
  expires_at: z.string(),
});

export const SessionRuntimePayloadSchema = z.object({
  state: SessionRuntimeStateSchema,
  load_strategy: SessionLoadStrategySchema,
  allowed_actions: z.array(SessionRuntimeActionSchema),
  active_run: SessionRuntimeActiveRunSchema.nullable(),
  last_run: SessionRuntimeLastRunSchema.nullable(),
  pending_interactions: z.array(SessionPendingInteractionSchema),
  resume_interaction_id: z.string().min(1).nullable(),
  maintenance: SessionRuntimeMaintenanceSchema.nullable(),
  observed_at: z.string(),
}).superRefine((runtime, context) => {
  if (runtime.load_strategy !== SESSION_LOAD_STRATEGY_BY_STATE[runtime.state]) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["load_strategy"], message: "load strategy does not match state" });
  }
  const activeState = runtime.state === "running"
    || runtime.state === "waiting_interaction"
    || runtime.state === "suspended"
    || runtime.state === "resuming";
  if (activeState !== Boolean(runtime.active_run)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["active_run"], message: "active run presence does not match state" });
  }
  if (runtime.active_run && runtime.active_run.status !== runtime.state) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["active_run", "status"], message: "active run status must match state" });
  }
  if ((runtime.state === "maintenance") !== Boolean(runtime.maintenance)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["maintenance"], message: "maintenance presence does not match state" });
  }
  if (runtime.state === "waiting_interaction" && runtime.pending_interactions.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pending_interactions"], message: "waiting interaction state requires a pending interaction" });
  }
  if (runtime.state !== "waiting_interaction" && runtime.state !== "suspended" && runtime.pending_interactions.length > 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pending_interactions"], message: "pending interactions are only valid while waiting or suspended" });
  }
  if (runtime.state === "suspended" && runtime.pending_interactions.length === 0 && !runtime.resume_interaction_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["pending_interactions"], message: "suspended state requires an unresolved or resumable interaction" });
  }
  if (runtime.state === "suspended" && runtime.pending_interactions.length > 0 && runtime.resume_interaction_id) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resume_interaction_id"], message: "suspended state cannot present interactions and resume a resolved batch at the same time" });
  }
  if (runtime.active_run?.execution_owner === "detached" && runtime.state !== "suspended") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["active_run", "execution_owner"], message: "detached ownership is only valid for suspended runs" });
  }
  if (runtime.state === "suspended" && runtime.active_run?.execution_owner !== "detached") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["active_run", "execution_owner"], message: "suspended runs must be detached" });
  }
  if ((runtime.allowed_actions.includes("resume_run")) !== Boolean(runtime.resume_interaction_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resume_interaction_id"], message: "resume interaction must match resume_run action" });
  }
  if (new Set(runtime.allowed_actions).size !== runtime.allowed_actions.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowed_actions"], message: "allowed actions must be unique" });
  }
  const owner = runtime.active_run?.execution_owner;
  const expectedActions: z.infer<typeof SessionRuntimeActionSchema>[] = runtime.state === "idle"
    ? ["send_message", "start_maintenance"]
    : runtime.state === "running"
      ? owner === "attached" ? ["send_followup", "stop_run"] : []
      : runtime.state === "waiting_interaction"
        ? owner === "attached" ? ["respond_interaction", "stop_run"] : []
        : runtime.state === "suspended"
          ? runtime.pending_interactions.length > 0 ? ["respond_interaction", "stop_run"] : ["resume_run", "stop_run"]
          : runtime.state === "resuming"
            ? owner === "attached" ? ["stop_run"] : []
            : [];
  const actualActionSet = new Set(runtime.allowed_actions);
  if (expectedActions.length !== actualActionSet.size || expectedActions.some((action) => !actualActionSet.has(action))) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["allowed_actions"], message: "allowed actions do not match state and execution owner" });
  }
});

export const UserDrivenChangePayloadSchema = z.object({
  category: z.enum(["task_submit", "message", "redirect", "env_notice"]),
  task: z.string().optional(),
  selected_llm: z.string().optional(),
  attachments: z.array(AttachmentRefSchema).optional(),
  request_id: z.string().optional(),
  ui_context: z.record(z.string(), z.unknown()).nullish(),
});

export const AbortPayloadSchema = z.object({
  scope: z.enum(["run", "tool_call"]),
  reason: z.string().optional(),
  ref_call_id: z.string().optional(),
});

export const CapabilityManifestPayloadSchema = z.object({
  protocol: ProtocolDescriptorSchema,
  capabilities: CapabilityDescriptorSchema,
  diff: z
    .object({
      added: z.array(z.string()).optional(),
      removed: z.array(z.string()).optional(),
    })
    .optional(),
});

/**
 * 顶层基础形状（纯 ZodObject，供 HelloEnvelopeSchema 等 extend 复用）。
 *
 * 维护提醒：本对象（zod 运行时校验）与上方 ProtocolEnvelope（TS 静态接口）是
 * 两份独立定义——新增 / 修改顶层字段时必须同步两者，否则运行时校验与静态类型不一致。
 * （EnvelopeSchema = EnvelopeBaseObject.superRefine(...)，派生自本对象，字段自动跟随，
 *   无需手动同步。）
 */
export const ProtocolEnvelopeSchema = z.object({
  protocol_version: z.literal("1.0").optional(),
  type: EnvelopeTypeSchema,
  session_id: z.string(),
  run_id: z.string().optional(),
  call_id: z.string().min(1).optional(),
  agent_id: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  message_id: z.string().optional(),
  boundary_message_id: z.string().optional(),
  timestamp: z.union([z.number().int(), z.string().datetime()]).optional(),
  payload: z.unknown().optional(),
});

/** 通用 envelope 校验：非握手帧 session_id 必填。 */
export const EnvelopeSchema = ProtocolEnvelopeSchema.superRefine((env, ctx) => {
  if (env.type !== "session.hello" && env.session_id.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "session_id required except in session.hello",
      path: ["session_id"],
    });
  }
});

export const HelloEnvelopeSchema = ProtocolEnvelopeSchema.extend({
  type: z.literal("session.hello"),
  protocol_version: z.literal("1.0"),
  payload: HelloPayloadSchema,
});

export const AgentStartedPayloadSchema = z.object({
  phase: z.literal("start"),
  task: z.string().optional(),
  display_name: z.string().optional(),
  invocation_call_id: z.string().min(1).optional(),
  child_agent_id: z.string().min(1).optional(),
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

const AgentEndedPayloadObjectSchema = z.object({
  phase: z.literal("end"),
  result: z.string().optional(),
  success: z.boolean(),
  status: z.enum(["succeeded", "failed", "interrupted"]),
  display_name: z.string().optional(),
  invocation_call_id: z.string().min(1).optional(),
  lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
});

export const AgentEndedPayloadSchema = AgentEndedPayloadObjectSchema.superRefine((payload, ctx) => {
  if (payload.success !== (payload.status === "succeeded")) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["success"],
      message: `success must be ${payload.status === "succeeded"} when status is ${payload.status}`,
    });
  }
});

export const AgentLifecyclePayloadSchema = z.union([
  AgentStartedPayloadSchema,
  AgentEndedPayloadSchema,
]);

const typed = <T extends z.ZodRawShape>(shape: T) => ProtocolEnvelopeSchema.extend(shape);

export const ServerToClientEnvelopeSchema = z.discriminatedUnion("type", [
  HelloEnvelopeSchema,
  typed({ type: z.literal("session.runtime"), session_id: z.string().min(1), payload: SessionRuntimePayloadSchema }),
  typed({ type: z.literal("heartbeat"), session_id: z.string().min(1), payload: HeartbeatPayloadSchema.optional() }),
  typed({ type: z.literal("session.reconnect"), session_id: z.string().min(1), payload: ReconnectPayloadSchema }),
  typed({ type: z.literal("error"), session_id: z.string().min(1), payload: ErrorPayloadSchema }),
  typed({ type: z.literal("run_started"), session_id: z.string().min(1), run_id: z.string().min(1), payload: RunStartedPayloadSchema.optional() }),
  typed({ type: z.literal("run_ended"), session_id: z.string().min(1), run_id: z.string().min(1), payload: RunEndedPayloadSchema }),
  typed({ type: z.literal("agent_started"), session_id: z.string().min(1), agent_id: z.string().min(1), call_id: z.string().min(1), payload: AgentStartedPayloadSchema }),
  typed({ type: z.literal("agent_ended"), session_id: z.string().min(1), agent_id: z.string().min(1), call_id: z.string().min(1), payload: AgentEndedPayloadSchema }),
  typed({ type: z.literal("model_request"), session_id: z.string().min(1), run_id: z.string().min(1), agent_id: z.string(), call_id: z.string().min(1), payload: ModelRequestPayloadSchema }),
  typed({ type: z.literal("model_attempt_started"), session_id: z.string().min(1), run_id: z.string().min(1), agent_id: z.string(), call_id: z.string().min(1), payload: ModelAttemptStartedPayloadSchema }),
  typed({ type: z.literal("model_attempt_failed"), session_id: z.string().min(1), run_id: z.string().min(1), agent_id: z.string(), call_id: z.string().min(1), payload: ModelAttemptFailedPayloadSchema }),
  typed({ type: z.literal("model_attempt_completed"), session_id: z.string().min(1), run_id: z.string().min(1), agent_id: z.string(), call_id: z.string().min(1), payload: ModelAttemptCompletedPayloadSchema }),
  typed({ type: z.literal("stream_output"), session_id: z.string().min(1), run_id: z.string().min(1), agent_id: z.string(), call_id: z.string().min(1), payload: StreamOutputPayloadSchema }),
  typed({ type: z.literal("state_sync"), session_id: z.string().min(1), payload: StateSyncPayloadSchema }),
  typed({ type: z.literal("tool_call"), session_id: z.string().min(1), call_id: z.string().min(1), payload: ToolCallPayloadSchema }),
  typed({ type: z.literal("tool_result"), session_id: z.string().min(1), call_id: z.string().min(1), payload: ToolResultPayloadSchema }),
  typed({ type: z.literal("agent_message"), session_id: z.string().min(1), run_id: z.string().min(1), payload: AgentMessagePayloadSchema }),
  typed({ type: z.literal("delegate_call"), session_id: z.string().min(1), call_id: z.string().min(1), payload: DelegateCallPayloadSchema }),
  typed({ type: z.literal("interaction"), session_id: z.string().min(1), call_id: z.string().min(1), payload: InteractionPayloadSchema.extend({ phase: z.literal("required") }) }),
  typed({ type: z.literal("abort"), session_id: z.string().min(1), payload: AbortPayloadSchema }),
  typed({ type: z.literal("capability_manifest"), session_id: z.string().min(1), payload: CapabilityManifestPayloadSchema }),
  typed({ type: z.literal("ack"), session_id: z.string().min(1), payload: AckPayloadSchema }),
]);

export type ServerToClientEnvelope = z.infer<typeof ServerToClientEnvelopeSchema>;

/** @deprecated Use ServerToClientEnvelopeSchema to make the wire direction explicit. */
export const TypedEnvelopeSchema = ServerToClientEnvelopeSchema;
/** @deprecated Use ServerToClientEnvelope. */
export type TypedEnvelope = ServerToClientEnvelope;

export const ClientToServerEnvelopeSchema = z.discriminatedUnion("type", [
  typed({ type: z.literal("user_driven_change"), session_id: z.string().min(1), payload: UserDrivenChangePayloadSchema.extend({ task: z.string().optional().default(""), attachments: z.array(AttachmentRefSchema).optional().default([]) }) }),
  typed({ type: z.literal("abort"), session_id: z.string().min(1), payload: z.object({ scope: z.literal("run"), reason: z.string().optional() }).optional() }),
  typed({ type: z.literal("interaction"), session_id: z.string().min(1), call_id: z.string().min(1), payload: z.object({ kind: z.enum(["approval", "user_input"]), phase: z.literal("responded"), approved: z.boolean().optional(), value: z.string().optional().default(""), message: z.string().optional().default("") }) }),
  typed({ type: z.literal("resume"), session_id: z.string().min(1), call_id: z.string().min(1), payload: z.object({ request_id: z.string().optional() }).optional() }),
  typed({ type: z.literal("tools.register"), session_id: z.string().min(1), payload: ToolsRegisterPayloadSchema }),
  typed({ type: z.literal("delegate_result"), session_id: z.string().min(1), call_id: z.string().min(1), payload: DelegateResultPayloadSchema }),
]);

export type ClientToServerEnvelope = z.infer<typeof ClientToServerEnvelopeSchema>;
