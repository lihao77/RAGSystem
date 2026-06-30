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
  "heartbeat",
  "session.reconnect",
  "error",
  "run_started",
  "run_ended",
  "agent_started",
  "agent_ended",
  "stream_output",
  "state_sync",
  "tool_call",
  "tool_result",
  "delegate_call",
  "delegate_result",
  "tools.register",
  "interaction",
  "user_driven_change",
  "abort",
  "capability_manifest",
  "ack",
]);
export type EnvelopeType = z.infer<typeof EnvelopeTypeSchema>;

export interface ProtocolEnvelope {
  /** 协议版本；仅 session.hello 必填并锁定连接，其余帧可省略。 */
  protocol_version?: ProtocolVersion;
  type: EnvelopeType;
  /** 会话标识；session.hello 握手帧外必填。 */
  session_id: string;
  /** run 标识；agent 运行时的执行单元身份（协议第一公民，非业务名词）。 */
  run_id?: string;
  /** 调用/交互关联标识：tool_call↔tool_result、interaction 请求↔响应、execution 树归属。 */
  call_id?: string;
  /** agent 身份标识；多 agent 并发 / 委派子 agent 区分执行体。 */
  agent_id?: string;
  /** 本连接内单调递增序号（去重）。 */
  seq?: number;
  /** 持久化事件游标（断线重连回放边界）。 */
  cursor?: number;
  message_id?: string;
  timestamp?: number | string;
  payload?: unknown;
}

/** 线协议信封的通用类型别名（供 SDK 门面引用）。 */
export type Envelope = ProtocolEnvelope;

/* ============================================================
 * 二、两个独立扩展点（互不嵌套、各自带扩展槽）
 * ========================================================== */

/** 扩展点 A：protocol —— agent 输出格式解析适配维度。 */
export interface ProtocolDescriptor {
  output: "xml_intent" | "native_function_call" | "hybrid";
  intent_tag_enabled?: boolean;
  function_call_mode?: "auto" | "required" | "none";
  streaming_framing?: "token" | "sentence" | "block";
}

/** 扩展点 B：capabilities —— 工具白名单 + 权限分级维度。 */
export interface CapabilityDescriptor {
  tools: ToolAllowance[];
  risk_policy: {
    low: "auto" | "notify";
    medium: "notify" | "require_approval";
    high: "require_approval" | "deny";
  };
  /** 委托宿主执行的工具（reserved，本期为空）。 */
  delegated_tools?: string[];
}

export interface ToolAllowance {
  name: string;
  risk_level?: RiskLevel;
  /** 是否由宿主执行（本期全 false，工具在后端本地执行）。 */
  host_executed?: boolean;
}

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
export interface DelegatedToolDeclaration {
  name: string;
  description: string;
  /** JSON Schema 参数描述（与后端 RuntimeTool schema 对齐）。 */
  input_schema: Record<string, unknown>;
  risk_level?: RiskLevel;
  /** 是否可取消（宿主前端支持 abort）。 */
  cancellable?: boolean;
}

/** 附件引用，形状对齐 contracts/execution.ts 的 AttachmentRef。 */
export interface AttachmentRef {
  file_id: string;
  original_name?: string | null;
  stored_name?: string | null;
  stored_path?: string | null;
  mime?: string | null;
  size?: number | null;
  kind?: string | null;
}

/* ============================================================
 * 四、各 type 的 payload
 * ========================================================== */

/* —— 控制帧 —— */
export interface HelloPayload {
  role: "host" | "agent-runtime";
  protocol: ProtocolDescriptor;
  capabilities: CapabilityDescriptor;
  resume?: { cursor?: number };
}
export interface HeartbeatPayload {
  last_seq?: number;
  last_cursor?: number;
}
export interface ReconnectPayload {
  phase: "start" | "end";
  replay_count?: number;
  replay_source?: "durable_outbox" | "memory";
}
export interface ErrorPayload {
  code: string;
  message: string;
  ref_call_id?: string;
}
export interface AckPayload {
  ref_message_id?: string;
  ref_call_id?: string;
  category: "send" | "stop" | "interaction" | "tool_delegate";
  ok: boolean;
  error?: string;
}

/* —— 生命周期帧 —— */
export interface RunStartedPayload {
  request_id?: string;
  task?: string;
}
export interface RunEndedPayload {
  status: "completed" | "failed" | "interrupted";
  reason?: string;
}
export interface AgentLifecyclePayload {
  phase: "start" | "end";
  task?: string;
  result?: string;
  success?: boolean;
  /** agent 展示名（中文等）；后端 AgentConfig.display_name，UI 据此显示而非英文 agent_id。 */
  display_name?: string;
  /** 子 agent 挂父：parent_call_id 指向父 agent 的 call_id（root agent 无）。 */
  lineage?: { parent_call_id?: string };
}

/* —— 内容流 —— */
export interface StreamOutputPayload {
  phase: "first_token" | "delta" | "final" | "intent_delta" | "intent_complete";
  content?: string;
  elapsed_ms?: number;
  round?: number;
}

/**
 * 状态同步：外部状态已变更，请对齐本地视图。
 * detail 透传 unknown：command_result / compression 等宿主侧语义不强制 schema。
 */
export interface StateSyncPayload {
  category:
    | "message_saved"
    | "session_updated"
    | "context_usage"
    | "compression"
    | "command_result"
    | "retry"
    | "waiting"
    | "reflection";
  ref?: { message_id?: string; seq?: number; role?: string; request_id?: string };
  metrics?: Record<string, number>;
  detail?: unknown;
}

/* —— 工具帧（投影通知，后端本地执行） —— */
export interface ToolCallPayload {
  tool: string;
  input?: unknown;
  phase: "start";
  status?: "running";
  /** 投影树归属辅助；仅保留 parent_call_id。 */
  lineage?: { parent_call_id?: string };
}
export interface ToolResultPayload {
  tool: string;
  phase: "end";
  ok: boolean;
  status?: "succeeded" | "failed";
  observation?: string;
  summary?: string;
  elapsed_ms?: number;
  approval?: { status: "pending" | "granted" | "denied"; message?: string };
  lineage?: { parent_call_id?: string };
  /** raw_result 系列不进协议，由宿主经独立资源通道拉取。 */
}

/* —— 委托帧（宿主执行，独立语义） —— */
/** 委托执行指令（后端→前端）：gate 通过后驱动宿主执行。独立于 tool_call（纯通知）。 */
export interface DelegateCallPayload {
  tool: string;
  input?: unknown;
  phase: "request";
  lineage?: { parent_call_id?: string };
}
/** 委托执行回传（前端→后端）：宿主执行结果，resolve 委托等待器。 */
export interface DelegateResultPayload {
  tool: string;
  phase: "result";
  ok: boolean;
  observation?: string;
  error?: string;
  elapsed_ms?: number;
}

/** tools.register 上行 payload：宿主声明本连接可委托执行的工具清单。 */
export interface ToolsRegisterPayload {
  tools: DelegatedToolDeclaration[];
}

/* —— 交互（单一 type，legacy 双发由 adapter 屏蔽） —— */
export interface InteractionPayload {
  kind: InteractionKind;
  /** required=后端→宿主；responded=宿主→后端。 */
  phase: "required" | "responded";
  tool?: string;
  input?: unknown;
  prompt?: string;
  risk_level?: RiskLevel;
  /** kind=approval, phase=responded。 */
  approved?: boolean;
  /** kind=user_input, phase=responded。 */
  value?: string;
  message?: string;
}

/* —— 用户驱动 / 取消 / 能力 —— */
export interface UserDrivenChangePayload {
  category: "task_submit" | "message" | "redirect" | "env_notice";
  task?: string;
  selected_llm?: string;
  attachments?: AttachmentRef[];
  /** 协议中唯一的 request_id（用户侧幂等键）；task_id 不进协议。 */
  request_id?: string;
}
export interface AbortPayload {
  scope: "run" | "tool_call";
  reason?: string;
  ref_call_id?: string;
}
export interface CapabilityManifestPayload {
  protocol: ProtocolDescriptor;
  capabilities: CapabilityDescriptor;
  diff?: { added?: string[]; removed?: string[] };
}

/* ============================================================
 * 五、zod validator
 * ========================================================== */

export const ProtocolDescriptorSchema = z.object({
  output: z.enum(["xml_intent", "native_function_call", "hybrid"]),
  intent_tag_enabled: z.boolean().optional(),
  function_call_mode: z.enum(["auto", "required", "none"]).optional(),
  streaming_framing: z.enum(["token", "sentence", "block"]).optional(),
});

export const CapabilityDescriptorSchema = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1),
      risk_level: z.enum(["low", "medium", "high"]).optional(),
      host_executed: z.boolean().optional(),
    }),
  ),
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
  cancellable: z.boolean().optional(),
});

const AttachmentRefSchema = z.object({
  file_id: z.string().min(1),
  original_name: z.string().nullable().optional(),
  stored_name: z.string().nullable().optional(),
  stored_path: z.string().nullable().optional(),
  mime: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  kind: z.string().nullable().optional(),
});

/**
 * 顶层基础形状（纯 ZodObject，供 HelloEnvelopeSchema 等 extend 复用）。
 *
 * 维护提醒：本对象（zod 运行时校验）与上方 ProtocolEnvelope（TS 静态接口）是
 * 两份独立定义——新增 / 修改顶层字段时必须同步两者，否则运行时校验与静态类型不一致。
 * （EnvelopeSchema = EnvelopeBaseObject.superRefine(...)，派生自本对象，字段自动跟随，
 *   无需手动同步。）
 */
const EnvelopeBaseObject = z.object({
  protocol_version: z.literal("1.0").optional(),
  type: EnvelopeTypeSchema,
  session_id: z.string(),
  run_id: z.string().optional(),
  call_id: z.string().min(1).optional(),
  agent_id: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  cursor: z.number().int().nonnegative().optional(),
  message_id: z.string().optional(),
  timestamp: z.union([z.number().int(), z.string().datetime()]).optional(),
  payload: z.unknown().optional(),
});

/** 通用 envelope 校验：非握手帧 session_id 必填。 */
export const EnvelopeSchema = EnvelopeBaseObject.superRefine((env, ctx) => {
  if (env.type !== "session.hello" && env.session_id.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "session_id required except in session.hello",
      path: ["session_id"],
    });
  }
});

export const HelloEnvelopeSchema = EnvelopeBaseObject.extend({
  type: z.literal("session.hello"),
  protocol_version: z.literal("1.0"),
  payload: z.object({
    role: z.enum(["host", "agent-runtime"]),
    protocol: ProtocolDescriptorSchema,
    capabilities: CapabilityDescriptorSchema,
    resume: z
      .object({ cursor: z.number().int().nonnegative().optional() })
      .optional(),
  }),
});

export const TypedEnvelopeSchema = z.discriminatedUnion("type", [
  HelloEnvelopeSchema,
  z.object({
    type: z.literal("heartbeat"),
    session_id: z.string().min(1),
    payload: z
      .object({
        last_seq: z.number().int().nonnegative().optional(),
        last_cursor: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("session.reconnect"),
    session_id: z.string().min(1),
    payload: z.object({
      phase: z.enum(["start", "end"]),
      replay_count: z.number().int().nonnegative().optional(),
      replay_source: z.enum(["durable_outbox", "memory"]).optional(),
    }),
  }),
  z.object({
    type: z.literal("error"),
    session_id: z.string().min(1),
    payload: z.object({
      code: z.string().min(1),
      message: z.string(),
      ref_call_id: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("run_started"),
    session_id: z.string().min(1),
    run_id: z.string().min(1),
    payload: z
      .object({ request_id: z.string().optional(), task: z.string().optional() })
      .optional(),
  }),
  z.object({
    type: z.literal("run_ended"),
    session_id: z.string().min(1),
    run_id: z.string().min(1),
    payload: z.object({
      status: z.enum(["completed", "failed", "interrupted"]),
      reason: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("agent_started"),
    session_id: z.string().min(1),
    agent_id: z.string(),
    call_id: z.string().min(1).optional(),
    payload: z
      .object({
        phase: z.literal("start"),
        task: z.string().optional(),
        display_name: z.string().optional(),
        lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("agent_ended"),
    session_id: z.string().min(1),
    agent_id: z.string(),
    call_id: z.string().min(1).optional(),
    payload: z
      .object({
        phase: z.literal("end"),
        result: z.string().optional(),
        success: z.boolean().optional(),
        display_name: z.string().optional(),
        lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
      })
      .optional(),
  }),
  z.object({
    type: z.literal("stream_output"),
    session_id: z.string().min(1),
    // 顶层路由 marker（run_id/call_id/agent_id）必须声明，否则 z.object 默认 strip，
    // 消费端 applyIntentStream 的 routeStreamAgent 拿不到 call_id → intent 误落 IMPLICIT_ROOT。
    run_id: z.string().optional(),
    call_id: z.string().optional(),
    agent_id: z.string().optional(),
    payload: z.object({
      phase: z.enum([
        "first_token",
        "delta",
        "final",
        "intent_delta",
        "intent_complete",
      ]),
      content: z.string().optional(),
      elapsed_ms: z.number().nonnegative().optional(),
      round: z.number().int().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal("state_sync"),
    session_id: z.string().min(1),
    payload: z.object({
      category: z.enum([
        "message_saved",
        "session_updated",
        "context_usage",
        "compression",
        "command_result",
        "retry",
        "waiting",
        "reflection",
      ]),
      ref: z
        .object({
          message_id: z.string().optional(),
          seq: z.number().int().nonnegative().optional(),
          role: z.string().optional(),
          request_id: z.string().optional(),
        })
        .optional(),
      metrics: z.record(z.number()).optional(),
      detail: z.unknown().optional(),
    }),
  }),
  z.object({
    type: z.literal("tool_call"),
    session_id: z.string().min(1),
    call_id: z.string().min(1),
    payload: z.object({
      tool: z.string().min(1),
      input: z.unknown().optional(),
      phase: z.literal("start"),
      status: z.literal("running").optional(),
      lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
    }),
  }),
  z.object({
    type: z.literal("tool_result"),
    session_id: z.string().min(1),
    call_id: z.string().min(1),
    payload: z.object({
      tool: z.string().min(1),
      phase: z.literal("end"),
      ok: z.boolean(),
      observation: z.string().optional(),
      summary: z.string().optional(),
      elapsed_ms: z.number().nonnegative().optional(),
      approval: z
        .object({
          status: z.enum(["pending", "granted", "denied"]),
          message: z.string().optional(),
        })
        .optional(),
      lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
    }),
  }),
  z.object({
    type: z.literal("delegate_call"),
    session_id: z.string().min(1),
    call_id: z.string().min(1),
    payload: z.object({
      tool: z.string().min(1),
      input: z.unknown().optional(),
      phase: z.literal("request"),
      lineage: z.object({ parent_call_id: z.string().optional() }).optional(),
    }),
  }),
  z.object({
    type: z.literal("delegate_result"),
    session_id: z.string().min(1),
    call_id: z.string().min(1),
    payload: z.object({
      tool: z.string().min(1),
      phase: z.literal("result"),
      ok: z.boolean(),
      observation: z.string().optional(),
      error: z.string().optional(),
      elapsed_ms: z.number().nonnegative().optional(),
    }),
  }),
  z.object({
    type: z.literal("interaction"),
    session_id: z.string().min(1),
    call_id: z.string().min(1),
    payload: z.object({
      kind: z.enum(["approval", "user_input"]),
      phase: z.enum(["required", "responded"]),
      tool: z.string().optional(),
      input: z.unknown().optional(),
      prompt: z.string().optional(),
      risk_level: z.enum(["low", "medium", "high"]).optional(),
      approved: z.boolean().optional(),
      value: z.string().optional(),
      message: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("user_driven_change"),
    session_id: z.string().min(1),
    payload: z.object({
      category: z.enum(["task_submit", "message", "redirect", "env_notice"]),
      task: z.string().optional(),
      selected_llm: z.string().optional(),
      attachments: z.array(AttachmentRefSchema).optional(),
      request_id: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("abort"),
    session_id: z.string().min(1),
    payload: z.object({
      scope: z.enum(["run", "tool_call"]),
      reason: z.string().optional(),
      ref_call_id: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal("capability_manifest"),
    session_id: z.string().min(1),
    payload: z.object({
      protocol: ProtocolDescriptorSchema,
      capabilities: CapabilityDescriptorSchema,
      diff: z
        .object({
          added: z.array(z.string()).optional(),
          removed: z.array(z.string()).optional(),
        })
        .optional(),
    }),
  }),
  z.object({
    type: z.literal("ack"),
    session_id: z.string().min(1),
    payload: z.object({
      ref_message_id: z.string().optional(),
      ref_call_id: z.string().optional(),
      category: z.enum(["send", "stop", "interaction", "tool_delegate"]),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  }),
]);

export type TypedEnvelope = z.infer<typeof TypedEnvelopeSchema>;
