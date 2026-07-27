import type { AttachmentRef, DelegatedToolDeclaration } from "@ragsystem/agent-protocol";

/**
 * widget 上行消息编码（client → server）。
 *
 * 对照 backend-ts/src/contracts/events.ts 的 ClientToServerEnvelopeSchema（discriminatedUnion on type）。
 * adapter 的 send/stop/respondInteraction/registerTool/delegateResult 各产一条上行帧，逐字段对齐 schema。
 */

export interface SendUplink {
  type: "user_driven_change";
  session_id: string;
  payload: {
    category: "task_submit";
    task: string;
    selected_llm?: string;
    attachments: AttachmentRef[];
    request_id?: string;
    /** 前端组件状态快照(对齐后端 events.ts task_submit 的 ui_context)。 */
    ui_context?: Record<string, unknown>;
  };
}

export interface StopUplink {
  type: "abort";
  session_id: string;
  payload: { scope: "run" };
}

export interface ApprovalRespondUplink {
  type: "interaction";
  session_id: string;
  call_id: string;
  payload: {
    kind: "approval";
    phase: "responded";
    approved: boolean;
    message?: string;
  };
}

export interface UserInputRespondUplink {
  type: "interaction";
  session_id: string;
  call_id: string;
  payload: {
    kind: "user_input";
    phase: "responded";
    value: string;
  };
}

export interface ToolsRegisterUplink {
  type: "tools.register";
  session_id: string;
  payload: { tools: DelegatedToolDeclaration[] };
}

export interface DelegateResultUplink {
  type: "delegate_result";
  session_id: string;
  call_id: string;
  payload: {
    phase: "result";
    ok: boolean;
    observation?: string;
    error?: string;
    elapsed_ms?: number;
  };
}

export type UplinkMessage =
  | SendUplink
  | StopUplink
  | ApprovalRespondUplink
  | UserInputRespondUplink
  | ToolsRegisterUplink
  | DelegateResultUplink;

export function encodeSend(sessionId: string, input: {
  task: string;
  selectedLlm?: string;
  attachments?: AttachmentRef[];
  requestId?: string;
  uiContext?: Record<string, unknown>;
}): SendUplink {
  const payload: SendUplink["payload"] = {
    category: "task_submit",
    task: input.task,
    attachments: (input.attachments ?? []).map(({ file_id }) => ({ file_id })),
  };
  if (input.selectedLlm) {
    payload.selected_llm = input.selectedLlm;
  }
  if (input.requestId) {
    payload.request_id = input.requestId;
  }
  if (input.uiContext) {
    payload.ui_context = input.uiContext;
  }
  return { type: "user_driven_change", session_id: sessionId, payload };
}

export function encodeStop(sessionId: string): StopUplink {
  return { type: "abort", session_id: sessionId, payload: { scope: "run" } };
}

export function encodeApprovalRespond(
  sessionId: string,
  callId: string,
  approved: boolean,
  message?: string,
): ApprovalRespondUplink {
  const payload: ApprovalRespondUplink["payload"] = { kind: "approval", phase: "responded", approved };
  if (message) {
    payload.message = message;
  }
  return { type: "interaction", session_id: sessionId, call_id: callId, payload };
}

export function encodeUserInputRespond(sessionId: string, callId: string, value: string): UserInputRespondUplink {
  return {
    type: "interaction",
    session_id: sessionId,
    call_id: callId,
    payload: { kind: "user_input", phase: "responded", value },
  };
}

export function encodeToolsRegister(sessionId: string, tools: DelegatedToolDeclaration[]): ToolsRegisterUplink {
  return { type: "tools.register", session_id: sessionId, payload: { tools } };
}

export function encodeDelegateResult(
  sessionId: string,
  callId: string,
  result: { ok: boolean; observation?: string; error?: string; elapsedMs?: number },
): DelegateResultUplink {
  const payload: DelegateResultUplink["payload"] = { phase: "result", ok: result.ok };
  if (result.observation !== undefined) {
    payload.observation = result.observation;
  }
  if (result.error !== undefined) {
    payload.error = result.error;
  }
  if (result.elapsedMs !== undefined) {
    payload.elapsed_ms = result.elapsedMs;
  }
  return { type: "delegate_result", session_id: sessionId, call_id: callId, payload };
}
