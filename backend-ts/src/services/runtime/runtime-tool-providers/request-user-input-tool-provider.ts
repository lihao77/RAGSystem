import type { PendingInteractionService } from "../pending-interaction-service.js";
import type {
  RuntimeToolCall,
  RuntimeToolDefinition,
  RuntimeToolExecutionContext,
  RuntimeToolProvider,
} from "../runtime-tool-types.js";
import { errorResult, readInputType, readOptions, readPrompt, successResult } from "../runtime-tool-bridge/arguments.js";
import { REQUEST_USER_INPUT_TOOL, REQUEST_USER_INPUT_TOOL_NAME } from "../runtime-tool-bridge/registry.js";

export class RequestUserInputToolProvider implements RuntimeToolProvider {
  readonly id = "request_user_input";

  constructor(private readonly pendingInteractions: PendingInteractionService | null) {}

  listTools(): RuntimeToolDefinition[] {
    return this.pendingInteractions ? [{ ...REQUEST_USER_INPUT_TOOL }] : [];
  }

  canHandle(toolName: string): boolean {
    return toolName === REQUEST_USER_INPUT_TOOL_NAME;
  }

  async executeTool(call: RuntimeToolCall, context: RuntimeToolExecutionContext) {
    if (!this.pendingInteractions) {
      return errorResult("request_user_input 暂不可用", REQUEST_USER_INPUT_TOOL_NAME);
    }
    const prompt = readPrompt(call.arguments);
    if (!prompt) {
      return errorResult("request_user_input 缺少 prompt", REQUEST_USER_INPUT_TOOL_NAME);
    }
    if (!context.sessionId) {
      return successResult("", {
        summary: "当前上下文缺少 session_id，未等待用户输入",
        outputType: "text",
        metadata: {
          input_type: readInputType(call.arguments),
          options: readOptions(call.arguments),
          degraded: true,
        },
        toolName: REQUEST_USER_INPUT_TOOL_NAME,
      });
    }

    const startedAt = Date.now();
    const resolution = await this.pendingInteractions.waitForUserInput({
      sessionId: context.sessionId,
      runId: context.runId,
      taskId: context.taskId,
      requestId: context.requestId,
      toolCallId: context.toolCallId ?? call.callId ?? null,
      agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
      prompt,
      inputType: readInputType(call.arguments),
      options: readOptions(call.arguments),
      signal: context.signal,
    });

    return successResult(resolution.value, {
      summary: "用户输入已接收",
      outputType: "text",
      metadata: {
        input_id: resolution.inputId,
        input_type: readInputType(call.arguments),
        options: readOptions(call.arguments),
        degraded: false,
        waited_seconds: (Date.now() - startedAt) / 1000,
      },
      toolName: REQUEST_USER_INPUT_TOOL_NAME,
    });
  }
}
