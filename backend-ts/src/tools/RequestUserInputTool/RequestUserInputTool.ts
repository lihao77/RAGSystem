import { z } from "zod";

import type { PendingInteractionService } from "../../services/runtime/pending-interaction-service.js";
import {
  errorResult,
  readInputType,
  readOptions,
  readPrompt,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import { REQUEST_USER_INPUT_TOOL_NAME } from "../../services/runtime/runtime-tool-bridge/registry.js";
import { buildTool, type RuntimeTool } from "../Tool.js";

interface RequestUserInputToolDeps {
  pendingInteractions: PendingInteractionService | null;
}

const requestUserInputSchema = z.object({
  prompt: z.string(),
  question: z.string().optional(),
  message: z.string().optional(),
  input_type: z.enum(["text", "select"]).optional(),
  inputType: z.string().optional(),
  options: z.array(z.string()).optional(),
}).strict();

export function createRequestUserInputTools(deps: RequestUserInputToolDeps): RuntimeTool[] {
  return [
    buildTool({
      name: REQUEST_USER_INPUT_TOOL_NAME,
      description:
        "Ask the user for missing information that is required to continue. Use only when the answer cannot be inferred or obtained with available tools.",
      source: "runtime_builtin",
      category: "interaction",
      riskLevel: "low",
      approvalExempt: true,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["prompt"],
        properties: {
          prompt: {
            type: "string",
            description: "Question shown to the user. Be specific about the missing information.",
          },
          input_type: {
            type: "string",
            enum: ["text", "select"],
            description: "Use text for free-form input, select when options are provided.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description: "Options for select input_type.",
          },
        },
      },
      inputSchema: requestUserInputSchema,
      isVisible: () => deps.pendingInteractions !== null,
      call: async (input, context) => {
        if (!deps.pendingInteractions) {
          return errorResult("request_user_input 暂不可用", REQUEST_USER_INPUT_TOOL_NAME);
        }
        const prompt = readPrompt(input);
        if (!prompt) {
          return errorResult("request_user_input 缺少 prompt", REQUEST_USER_INPUT_TOOL_NAME);
        }
        const sessionId = context.sessionId?.trim();
        if (!sessionId) {
          return errorResult("request_user_input 缺少 session_id", REQUEST_USER_INPUT_TOOL_NAME);
        }
        try {
          const resolution = await deps.pendingInteractions.waitForUserInput({
            sessionId,
            runId: context.runId,
            taskId: context.taskId,
            requestId: context.requestId,
            toolCallId: context.toolCallId,
            agentName: context.currentAgentName ?? context.agent?.agent_name ?? null,
            prompt,
            inputType: readInputType(input),
            options: readOptions(input),
            signal: context.signal,
          });
          return {
            success: true,
            tool_name: REQUEST_USER_INPUT_TOOL_NAME,
            summary: "用户输入已接收",
            answer: null,
            output_type: "text",
            content: resolution.value,
            metadata: {
              input_id: resolution.inputId,
              input_type: readInputType(input),
              options: readOptions(input),
              responded_at: resolution.respondedAt,
              degraded: false,
            },
            artifacts: [],
            llm_hint: null,
          };
        } catch (error) {
          return errorResult(
            `request_user_input 失败: ${error instanceof Error ? error.message : String(error)}`,
            REQUEST_USER_INPUT_TOOL_NAME,
          );
        }
      },
    }),
  ];
}
