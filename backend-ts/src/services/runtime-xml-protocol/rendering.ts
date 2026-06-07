import type { ChatMessage } from "../llm-chat-client.js";
import type { ToolExecutionResult } from "../memory-tool-service.js";
import type { RuntimeToolDefinition } from "../runtime-tool-types.js";

export function renderRuntimeXmlProtocolInstruction(tools: RuntimeToolDefinition[]): string {
  const protocol = [
    "You must output runtime XML phases, without Markdown fences.",
    "Use <intent> only for a short natural language action note visible to the user. Do not expose hidden reasoning.",
    "Use <tool_calls> when a tool is needed. Tool calls are hidden from the user and parsed by the runtime.",
    "Use <final_answer> only when the task is complete. The final answer is the only assistant message persisted as the final response.",
    "Do not mix <final_answer> with <tool_calls> in the same round.",
    "Preferred tool call format:",
    '<tool_calls><tool name="tool_name"><param_name>value</param_name></tool></tool_calls>',
    "Use CDATA for multiline text or content containing XML-sensitive characters.",
    "Legacy aliases <tools> and <answer> are accepted, but prefer <tool_calls> and <final_answer>.",
  ].join("\n");

  return [
    renderSemanticBlock("runtime_instruction", protocol, {
      source: "ts_runtime",
      kind: "xml_protocol",
    }),
    renderToolManifest(tools),
  ].join("\n\n");
}

export function renderProtocolFeedbackMessage(error: string, attempt: number, maxAttempts: number): ChatMessage {
  const feedback = [
    `The previous assistant output could not be parsed by the runtime XML protocol: ${error}`,
    `Repair attempt ${attempt}/${maxAttempts}. Regenerate this round only.`,
    "Output exactly one of these forms:",
    "<intent>short visible action note</intent><tool_calls>...</tool_calls>",
    "<final_answer>final answer</final_answer>",
    "Do not explain the protocol error.",
  ].join("\n");

  return {
    role: "user",
    content: renderSemanticBlock("protocol_feedback", feedback, {
      source: "runtime",
      attempt: String(attempt),
      max_attempts: String(maxAttempts),
    }),
  };
}

export function renderToolResultMessage(input: {
  callId: string;
  toolName: string;
  result: ToolExecutionResult;
}): ChatMessage {
  return {
    role: "user",
    content: renderToolResultContent(input),
  };
}

export function renderToolResultContent(input: {
  callId: string;
  toolName: string;
  result: ToolExecutionResult;
}): string {
  const semantic = inferToolResultSemantic(input.toolName, input.result);
  return renderSemanticBlock("tool_result", renderCompactToolObservation(input.result, input.toolName), {
    id: input.callId,
    name: input.toolName,
    ok: input.result.success ? "true" : "false",
    ...(semantic ? { semantic } : {}),
  });
}

export function renderSemanticBlock(tagName: string, content: string, attributes: Record<string, string> = {}): string {
  const renderedAttributes = Object.entries(attributes)
    .filter(([, value]) => value.trim())
    .map(([key, value]) => ` ${key}="${escapeXmlAttribute(value)}"`)
    .join("");
  return `<${tagName}${renderedAttributes}>${wrapCdata(content)}</${tagName}>`;
}

export function isSemanticTaggedContent(content: string): boolean {
  return /^<([A-Za-z_][\w:-]*)(\s[^>]*)?>[\s\S]*<\/\1>\s*$/.test(content.trim());
}

function renderToolManifest(tools: RuntimeToolDefinition[]): string {
  const renderedTools = tools
    .map((tool) =>
      [
        `<tool name="${escapeXmlAttribute(tool.name)}">`,
        renderSemanticBlock("description", tool.description),
        renderSemanticBlock("parameters", JSON.stringify(tool.parameters, null, 2), { format: "json_schema" }),
        "</tool>",
      ].join("\n"),
    )
    .join("\n");
  return `<tool_manifest>\n${renderedTools}\n</tool_manifest>`;
}

function renderCompactToolObservation(result: ToolExecutionResult, toolName: string): string {
  if (!result.success) {
    return `[ERROR] ${stringifyToolContent(result.content) || "未知错误"}`;
  }

  if (result.tool_name === "request_user_input" && typeof result.content === "string") {
    return appendLlmHint(result.content, result);
  }

  if ((result.tool_name || toolName) === "execute_bash") {
    return appendLlmHint(renderBashToolObservation(result), result);
  }

  const renderedContent = renderToolContentForObservation(result.content, result.output_type);
  let observation = renderObservationPrefix(result);
  if (renderedContent) {
    if (observation && !(result.summary && renderedContent.trim() === result.summary.trim())) {
      observation += `\n\n${renderedContent}`;
    } else if (!observation) {
      observation = renderedContent;
    }
  }
  return appendLlmHint(observation || result.summary, result);
}

function inferToolResultSemantic(toolName: string, result: ToolExecutionResult): string | null {
  const semantic = result.metadata.semantic;
  if (typeof semantic === "string" && semantic.trim()) {
    return semantic.trim();
  }
  return toolName === "request_user_input" ? "user_input_response" : null;
}

function renderObservationPrefix(result: ToolExecutionResult): string {
  let prefix = "";
  const answer = typeof result.answer === "string" && result.answer.trim() ? result.answer.trim() : null;
  if (answer) {
    prefix += answer;
  } else if (result.summary) {
    prefix += result.summary;
  }
  const metadataPrefix = renderMetadataObservationPrefix(result);
  if (metadataPrefix) {
    prefix += prefix ? `\n\n${metadataPrefix}` : metadataPrefix;
  }
  return prefix;
}

function renderMetadataObservationPrefix(result: ToolExecutionResult): string {
  const childAgentId = typeof result.metadata.child_agent_id === "string" && result.metadata.child_agent_id.trim()
    ? result.metadata.child_agent_id.trim()
    : null;
  const approvalMessage = typeof result.metadata.approval_message === "string" && result.metadata.approval_message.trim()
    ? result.metadata.approval_message.trim()
    : null;
  const parts: string[] = [];
  if (childAgentId) {
    parts.push(`child_agent_id: ${childAgentId}`);
  }
  if (approvalMessage) {
    parts.push(`用户批注: ${approvalMessage}`);
  }
  return parts.join("\n\n");
}

function renderBashToolObservation(result: ToolExecutionResult): string {
  const content = result.content;
  const summary = result.summary || "";
  if (!isRecord(content)) {
    const rendered = stringifyToolContent(content);
    return summary ? `${summary}\n${rendered}` : rendered;
  }

  const stdout = typeof content.stdout === "string" ? content.stdout : "";
  const stderr = typeof content.stderr === "string" ? content.stderr : "";
  const returnCode = typeof content.return_code === "number" ? content.return_code : null;
  const interrupted = content.interrupted === true;
  const backgroundTaskId = typeof content.background_task_id === "string" && content.background_task_id.trim()
    ? content.background_task_id.trim()
    : null;

  if (backgroundTaskId) {
    const parts = ["后台任务已启动", `task_id: ${backgroundTaskId}`];
    if (summary) {
      parts.unshift(summary);
    }
    return parts.join("\n");
  }

  const parts: string[] = [];
  if (summary) {
    parts.push(summary);
  }

  if (interrupted) {
    if (stdout) {
      parts.push(stdout);
    }
    if (stderr) {
      parts.push(`[stderr]\n${stderr}`);
    }
    return parts.join("\n");
  }

  if (returnCode !== null && returnCode !== undefined && returnCode !== 0) {
    if (stderr) {
      parts.push(`[stderr]\n${stderr}`);
    }
    if (stdout) {
      parts.push(`[stdout]\n${stdout}`);
    }
    return parts.join("\n");
  }

  if (stdout) {
    parts.push(stdout);
  }
  if (stderr) {
    parts.push(`[stderr]\n${stderr}`);
  }

  return parts.length ? parts.join("\n") : summary || "命令执行完成";
}

function renderToolContentForObservation(content: unknown, outputType: string): string {
  if (content === null || content === undefined) {
    return "";
  }
  if (typeof content === "string") {
    return content;
  }
  if (outputType === "json" || Array.isArray(content) || isRecord(content)) {
    return `\`\`\`json\n${stringifyJsonForObservation(content)}\n\`\`\``;
  }
  return stringifyToolContent(content);
}

function appendLlmHint(observation: string, result: ToolExecutionResult): string {
  const hint = typeof result.llm_hint === "string" && result.llm_hint.trim() ? result.llm_hint.trim() : null;
  if (!hint) {
    return observation;
  }
  return observation ? `${observation}\n${hint}` : hint;
}

function stringifyJsonForObservation(content: unknown): string {
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return stringifyToolContent(content);
  }
}

function stringifyToolContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (content === null || content === undefined) {
    return "";
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

function wrapCdata(value: string): string {
  return `<![CDATA[${value.replaceAll("]]>", "]]]]><![CDATA[>")}]]>`;
}

function escapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
