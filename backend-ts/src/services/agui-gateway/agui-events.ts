/**
 * AG-UI 协议事件契约（手写，严格对照 AG-UI 官方 schema）。
 *
 * 不引入 @ag-ui/core 运行时依赖：事件 schema 字段少、camelCase 明确，SSE 编码即
 * `data: {json}\n\n`。网关据此构造事件，任何 AG-UI 兼容客户端（@ag-ui/client、CopilotKit）
 * 可消费。字段名/枚举值以 docs.ag-ui.com/concepts/events 为准。
 */
export const AguiEventType = {
  RUN_STARTED: "RUN_STARTED",
  RUN_FINISHED: "RUN_FINISHED",
  RUN_ERROR: "RUN_ERROR",
  STEP_STARTED: "STEP_STARTED",
  STEP_FINISHED: "STEP_FINISHED",
  TEXT_MESSAGE_START: "TEXT_MESSAGE_START",
  TEXT_MESSAGE_CONTENT: "TEXT_MESSAGE_CONTENT",
  TEXT_MESSAGE_END: "TEXT_MESSAGE_END",
  REASONING_MESSAGE_START: "REASONING_MESSAGE_START",
  REASONING_MESSAGE_CONTENT: "REASONING_MESSAGE_CONTENT",
  REASONING_MESSAGE_END: "REASONING_MESSAGE_END",
  TOOL_CALL_START: "TOOL_CALL_START",
  TOOL_CALL_ARGS: "TOOL_CALL_ARGS",
  TOOL_CALL_END: "TOOL_CALL_END",
  TOOL_CALL_RESULT: "TOOL_CALL_RESULT",
  STATE_SNAPSHOT: "STATE_SNAPSHOT",
  CUSTOM: "CUSTOM",
} as const;
export type AguiEventType = (typeof AguiEventType)[keyof typeof AguiEventType];

/** 所有事件都带 threadId/runId，保证客户端 thread context 完整（多余字段客户端忽略）。 */
export interface AguiBaseEvent {
  type: AguiEventType;
  threadId: string;
  runId: string;
  timestamp?: number;
}

export interface RunStartedEvent extends AguiBaseEvent {
  type: "RUN_STARTED";
}
export interface RunFinishedEvent extends AguiBaseEvent {
  type: "RUN_FINISHED";
  outcome?: { type: "success" } | { type: "interrupt"; interrupts: AguiInterrupt[] };
  result?: unknown;
}
export interface RunErrorEvent extends AguiBaseEvent {
  type: "RUN_ERROR";
  message: string;
  code?: string;
}
export interface TextMessageStartEvent extends AguiBaseEvent {
  type: "TEXT_MESSAGE_START";
  messageId: string;
  role?: string;
}
export interface TextMessageContentEvent extends AguiBaseEvent {
  type: "TEXT_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}
export interface TextMessageEndEvent extends AguiBaseEvent {
  type: "TEXT_MESSAGE_END";
  messageId: string;
}
export interface ReasoningMessageStartEvent extends AguiBaseEvent {
  type: "REASONING_MESSAGE_START";
  messageId: string;
}
export interface ReasoningMessageContentEvent extends AguiBaseEvent {
  type: "REASONING_MESSAGE_CONTENT";
  messageId: string;
  delta: string;
}
export interface ReasoningMessageEndEvent extends AguiBaseEvent {
  type: "REASONING_MESSAGE_END";
  messageId: string;
}
export interface ToolCallStartEvent extends AguiBaseEvent {
  type: "TOOL_CALL_START";
  toolCallId: string;
  toolCallName: string;
  parentMessageId?: string;
}
export interface ToolCallArgsEvent extends AguiBaseEvent {
  type: "TOOL_CALL_ARGS";
  toolCallId: string;
  delta: string;
}
export interface ToolCallEndEvent extends AguiBaseEvent {
  type: "TOOL_CALL_END";
  toolCallId: string;
}
export interface ToolCallResultEvent extends AguiBaseEvent {
  type: "TOOL_CALL_RESULT";
  messageId: string;
  toolCallId: string;
  content: string;
  role?: string;
}
export interface StepStartedEvent extends AguiBaseEvent {
  type: "STEP_STARTED";
  stepName: string;
}
export interface StepFinishedEvent extends AguiBaseEvent {
  type: "STEP_FINISHED";
  stepName: string;
}
export interface StateSnapshotEvent extends AguiBaseEvent {
  type: "STATE_SNAPSHOT";
  snapshot: Record<string, unknown>;
}
export interface CustomEvent extends AguiBaseEvent {
  type: "CUSTOM";
  name: string;
  value: unknown;
}

export type AguiEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | CustomEvent;

/** AG-UI interrupt：run 以 outcome:interrupt 结束时携带，client 用 resume 数组回应。 */
export interface AguiInterrupt {
  id: string;
  reason: string; // "tool_call" | "input_required" | "confirmation" | 自定义
  message?: string;
  toolCallId?: string;
  responseSchema?: Record<string, unknown>;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/** SSE 编码：每事件一行 `data: {json}\n\n`。 */
export function encodeAguiSse(event: AguiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}
