import type { DelegatedToolDeclarationWire } from "../../contracts/events.js";
import { AttachmentRefSchema, type AttachmentRef } from "@ragsystem/agent-protocol";
import { ALL_THINKING_LEVELS, type ThinkingLevel } from "@ragsystem/agent-llm";

/** AG-UI client-defined tool 声明（上行 RunAgentInput.tools 元素）。 */
export interface AguiClientTool {
  name: string;
  description?: string;
  /** JSON Schema 参数描述。 */
  parameters?: Record<string, unknown>;
  /** RAGSystem 扩展：未声明时保持 medium。 */
  riskLevel?: "low" | "medium" | "high";
  /** RAGSystem 扩展：是否不产生持久化业务变更，未声明时为 false。 */
  readOnly?: boolean;
}

/** AG-UI message（上行 RunAgentInput.messages 元素）。 */
export interface AguiMessage {
  id?: string;
  role: "user" | "assistant" | "system" | "tool" | "developer";
  content?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

/** AG-UI resume 项（回应上一个 run 的 interrupt）。 */
export interface AguiResumeItem {
  interruptId: string;
  status: "resolved" | "cancelled";
  payload?: unknown;
}

/** RAGSystem extension: attach an AG-UI SSE request to an existing active run. */
export interface AguiReconnectInput {
  runId: string;
  afterSeq?: number;
}

/** AG-UI RunAgentInput（POST /api/agui body）。 */
export interface RunAgentInput {
  threadId?: string;
  runId?: string;
  state?: Record<string, unknown>;
  messages?: AguiMessage[];
  tools?: AguiClientTool[];
  context?: unknown[];
  forwardedProps?: Record<string, unknown>;
  resume?: AguiResumeItem[];
  reconnect?: AguiReconnectInput;
  attachments?: AttachmentRef[];
  /** RAGSystem extension: preserve the selected model used by the native chat client. */
  selectedLlm?: string;
  /** RAGSystem extension: 请求级思考档位（8 档，见 agent-llm ALL_THINKING_LEVELS）。 */
  thinkingLevel?: ThinkingLevel;
}

/**
 * AG-UI client tool → 内部 DelegatedToolDeclarationWire（覆盖式注册用）。
 * riskLevel/readOnly 是兼容 AG-UI 基础字段的 RAGSystem 可选扩展；旧客户端仍按
 * medium + 非只读处理。未知值不得降低默认风险。
 */
export function mapClientTools(tools: AguiClientTool[] | undefined): DelegatedToolDeclarationWire[] {
  if (!tools?.length) {
    return [];
  }
  return tools.map((tool) => {
    const riskLevel = tool.riskLevel === "low" || tool.riskLevel === "medium" || tool.riskLevel === "high"
      ? tool.riskLevel
      : "medium";
    return {
      name: tool.name,
      description: tool.description ?? "",
      input_schema: tool.parameters ?? { type: "object", properties: {} },
      risk_level: riskLevel,
      read_only: tool.readOnly === true,
      cancellable: true,
    };
  });
}

/** 取末条 user 消息 content 作为内部 startStream 的 task。 */
export function lastUserTask(messages: AguiMessage[] | undefined): string {
  if (!messages?.length) {
    return "";
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message && message.role === "user") {
      return message.content ?? "";
    }
  }
  return "";
}

/** 宽松解析 POST body 为 RunAgentInput（容忍客户端字段大小写/缺省）。 */
export function parseRunAgentInput(body: unknown): RunAgentInput {
  if (body === null || typeof body !== "object") {
    return {};
  }
  const raw = body as Record<string, unknown>;
  const input: RunAgentInput = {};
  if (typeof raw.threadId === "string") input.threadId = raw.threadId;
  if (typeof raw.runId === "string") input.runId = raw.runId;
  if (Array.isArray(raw.messages)) input.messages = raw.messages as AguiMessage[];
  if (Array.isArray(raw.tools)) input.tools = raw.tools as AguiClientTool[];
  if (raw.forwardedProps !== null && typeof raw.forwardedProps === "object" && !Array.isArray(raw.forwardedProps)) {
    input.forwardedProps = raw.forwardedProps as Record<string, unknown>;
  }
  if (Array.isArray(raw.resume)) input.resume = raw.resume as AguiResumeItem[];
  if (raw.reconnect !== null && typeof raw.reconnect === "object" && !Array.isArray(raw.reconnect)) {
    const reconnect = raw.reconnect as Record<string, unknown>;
    if (typeof reconnect.runId === "string" && reconnect.runId.trim()) {
      const afterSeq = reconnect.afterSeq;
      input.reconnect = {
        runId: reconnect.runId,
        ...(typeof afterSeq === "number" && Number.isSafeInteger(afterSeq) && afterSeq >= 0 ? { afterSeq } : {}),
      };
    }
  }
  if (Array.isArray(raw.attachments)) input.attachments = raw.attachments.map((item) => AttachmentRefSchema.parse(item));
  if (typeof raw.selectedLlm === "string" && raw.selectedLlm.trim()) input.selectedLlm = raw.selectedLlm;
  if (typeof raw.thinkingLevel === "string" && (ALL_THINKING_LEVELS as readonly string[]).includes(raw.thinkingLevel)) {
    input.thinkingLevel = raw.thinkingLevel as ThinkingLevel;
  }
  if (raw.state !== null && typeof raw.state === "object") input.state = raw.state as Record<string, unknown>;
  return input;
}
