import { z } from "zod";

import { isAbortError, RecoverableInterrupt } from "@ragsystem/agent-protocol";
import { resolveInteractionDeadlineMs, type PendingInteractionPort } from "../../contracts/runtime/pending-interactions.js";
import {
  readInputType,
  readOptions,
  readPrompt,
} from "../../services/runtime/runtime-tool-bridge/arguments.js";
import { REQUEST_USER_INPUT_TOOL_NAME } from "../../services/runtime/runtime-tool-bridge/registry.js";
import { buildTool, type Tool, type ToolAccessDecision, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../contracts/agent/agent-config.js";
import { toolError, toolSuccess } from "../../services/agent/sdk/tool-results.js";

interface RequestUserInputToolDeps {
  pendingInteractions: PendingInteractionPort | null;
  agent: AgentConfig;
}

const requestUserInputSchema = z.object({
  prompt: z.string(),
  question: z.string().optional(),
  message: z.string().optional(),
  input_type: z.enum(["text", "select"]).optional(),
  inputType: z.string().optional(),
  options: z.array(z.string()).optional(),
}).strict();

export function createRequestUserInputTools(deps: RequestUserInputToolDeps): Tool[] {
  // 可见性：pendingInteractions 不可用时无工具
  if (!deps.pendingInteractions) {
    return [];
  }
  const { agent } = deps;
  return [
    buildTool({
      name: REQUEST_USER_INPUT_TOOL_NAME,
      description:
        "Ask the user for missing information that is required to continue. Use only when the answer cannot be inferred or obtained with available tools.",
      source: "runtime_builtin",
      category: "interaction",
      riskLevel: "low",
      checkAccess: (): ToolAccessDecision => ({ action: "allow", signals: { approvalExempt: true } }),
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
      call: async (input, ctx: ToolExecContext) => {
        const prompt = readPrompt(input);
        if (!prompt) {
          return toolError(REQUEST_USER_INPUT_TOOL_NAME, "request_user_input 缺少 prompt");
        }
        const sessionId = ctx.sessionId?.trim();
        if (!sessionId) {
          return toolError(REQUEST_USER_INPUT_TOOL_NAME, "request_user_input 缺少 session_id");
        }
        if (!ctx.runId || !ctx.toolCallId) {
          return toolError(REQUEST_USER_INPUT_TOOL_NAME, "request_user_input 缺少 run_id 或 tool_call_id");
        }
        try {
          const resolution = await deps.pendingInteractions!.waitForUserInput({
            sessionId,
            runId: ctx.runId,
            rootRunId: ctx.rootRunId ?? ctx.runId,
            parentRunId: ctx.parentRunId ?? null,
            parentCallId: ctx.runParentCallId ?? null,
            ...(ctx.parentCallId ? { rootCallId: ctx.parentCallId } : {}),
            taskId: ctx.taskId,
            requestId: ctx.requestId,
            toolCallId: ctx.toolCallId,
            ...(ctx.interactionBatchId ? { interactionBatchId: ctx.interactionBatchId } : {}),
            ...(ctx.onInteractionRequired ? { onInteractionRequired: ctx.onInteractionRequired } : {}),
            deadlineMs: resolveInteractionDeadlineMs(ctx.executionKind),
            task: ctx.rootTask ?? "",
            executionKind: ctx.executionKind,
            agentName: ctx.currentAgentName ?? agent.agent_name,
            prompt,
            inputType: readInputType(input),
            options: readOptions(input),
            signal: ctx.signal,
          });
          return toolSuccess(resolution.value, {
            toolName: REQUEST_USER_INPUT_TOOL_NAME,
            summary: "用户输入已接收",
            outputType: "text",
            metadata: {
              input_id: resolution.inputId,
              input_type: readInputType(input),
              options: readOptions(input),
              responded_at: resolution.respondedAt,
              degraded: false,
            },
          });
        } catch (error) {
          if (isAbortError(error) || ctx.signal?.aborted) { throw error; }
          if (error instanceof RecoverableInterrupt) { throw error; }
          return toolError(
            REQUEST_USER_INPUT_TOOL_NAME,
            `request_user_input 失败: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      },
    }),
  ];
}
