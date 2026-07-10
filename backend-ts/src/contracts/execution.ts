import { z } from "zod";

import { InteractionResponsePayloadSchema } from "./interactions.js";
import { OptionalSessionIdSchema, RequiredSessionIdSchema } from "./session-id.js";

export const AttachmentRefSchema = z.object({
  file_id: z.string().min(1),
  original_name: z.string().nullable().optional(),
  stored_name: z.string().nullable().optional(),
  stored_path: z.string().nullable().optional(),
  mime: z.string().nullable().optional(),
  size: z.number().int().nonnegative().nullable().optional(),
  kind: z.string().nullable().optional(),
});

export const StreamExecuteRequestSchema = z.object({
  task: z.string().optional().default(""),
  session_id: OptionalSessionIdSchema.nullable().optional(),
  user_id: z.string().nullable().optional(),
  selected_llm: z.string().nullable().optional(),
  selectedLLM: z.string().nullable().optional(),
  attachments: z.array(AttachmentRefSchema).optional().default([]),
  // 前端组件状态快照(ui_context extension 的 data):backend 透传 + 投影,结构由前端定义。
  ui_context: z.record(z.string(), z.unknown()).nullish(),
});

// /execute(同步执行)不支持附件/ui_context:executeSynchronously 不解析附件也不投影 ui_context。
// 显式声明为 never——客户端误传该字段 → ZodError(全局 handler 返回 400),而非静默 strip。
// (omit 仅从类型移除字段,运行时 zod 默认仍 strip 多余 key 不报错;never 才是真拒绝。)
export const ExecuteRequestSchema = StreamExecuteRequestSchema.extend({
  agent: z.string().nullable().optional(),
  attachments: z.never().optional(),
  ui_context: z.never().optional(),
});

export const CollaborateTaskSchema = z.object({
  task: z.string(),
  agent: z.string().nullable().optional(),
});

export const CollaborateRequestSchema = z.object({
  tasks: z.array(CollaborateTaskSchema).min(1),
  session_id: OptionalSessionIdSchema.nullable().optional(),
  user_id: z.string().nullable().optional(),
  mode: z.string().optional().default("sequential"),
});

export const StreamStopRequestSchema = z.object({
  session_id: RequiredSessionIdSchema,
});

export const ApprovalRequestSchema = z.object({
  approved: z.boolean().optional().default(false),
  message: z.string().optional().default(""),
});

export const UserInputRequestSchema = z.object({
  value: z.string().optional().default(""),
});
export const InteractionRequestSchema = InteractionResponsePayloadSchema;

export type AttachmentRef = z.infer<typeof AttachmentRefSchema>;
export type ExecuteRequest = z.infer<typeof ExecuteRequestSchema>;
export type StreamExecuteRequest = z.infer<typeof StreamExecuteRequestSchema>;
export type StreamStopRequest = z.infer<typeof StreamStopRequestSchema>;
export type CollaborateTask = z.infer<typeof CollaborateTaskSchema>;
export type CollaborateRequest = z.infer<typeof CollaborateRequestSchema>;
export type ApprovalRequest = z.infer<typeof ApprovalRequestSchema>;
export type UserInputRequest = z.infer<typeof UserInputRequestSchema>;
export type InteractionRequest = z.infer<typeof InteractionRequestSchema>;

export interface AgentRunStartResult {
  started: boolean;
  session_id: string;
  run_id?: string;
  task_id?: string;
  request_id?: string;
  kind?: "agent_run" | "command";
  error?: string;
}

export interface AgentExecuteResult {
  success: boolean;
  answer: string | null;
  agent_name: string | null;
  execution_time: number | null;
  tool_calls: unknown[];
  metadata: Record<string, unknown>;
  session_id: string;
  run_id: string | null;
  task_id: string | null;
  error: string | null;
}

export interface RollbackRetryStartResult extends AgentRunStartResult {
  deleted: number;
  agent_name?: string | undefined;
}

export interface ExecutionObservability {
  task_id: string | null;
  session_id: string | null;
  run_id: string | null;
  execution_kind: string | null;
  request_id: string | null;
}

export interface ExecutionTaskStatus {
  task_id: string;
  session_id: string | null;
  run_id: string | null;
  request_id: string | null;
  execution_kind: string;
  task: string;
  status: string;
  elapsed_seconds: number | null;
  started_at: string | null;
  finished_at: string | null;
  thread_alive: boolean;
}

export interface ExecutionDiagnostics {
  task: ExecutionTaskStatus;
  runner: Record<string, unknown> | null;
  observability: ExecutionObservability;
  handle_registered: boolean;
  is_running: boolean;
}

export interface SessionTaskStatus {
  session_id: string;
  has_running_task: boolean;
  has_active_system_command: boolean;
  task_info: ExecutionTaskStatus | null;
  observability: ExecutionObservability | null;
  diagnostics: ExecutionDiagnostics | null;
}

export interface ScopedExecutionDiagnostics {
  session_id?: string;
  task_id?: string;
  scope: "session_id" | "task_id";
  scope_id: string;
  found: boolean;
  diagnostics: ExecutionDiagnostics | null;
}

export interface ScopedTaskStatus {
  task_id: string;
  scope: "task_id";
  scope_id: string;
  found: boolean;
  has_running_task: boolean;
  task_info: ExecutionTaskStatus | null;
  observability: ExecutionObservability | null;
}

export interface RunningTasksResult {
  active_only: boolean;
  count: number;
  items: ExecutionTaskStatus[];
}

export interface ExecutionOverview {
  active_only: boolean;
  count: number;
  by_execution_kind: Record<string, number>;
  by_status: Record<string, number>;
  sessions: string[];
  items: ExecutionTaskStatus[];
}

// 结构类型签名:只读 selected_llm/selectedLLM,兼容 StreamExecuteRequest / ExecuteRequest(omit 后无 attachments)。
// 显式 undefined 适配 exactOptionalPropertyTypes(zod optional nullable 推断为 string | null | undefined)。
export function getSelectedLlm(request: { selected_llm?: string | null | undefined; selectedLLM?: string | null | undefined }): string {
  return request.selected_llm ?? request.selectedLLM ?? "";
}
