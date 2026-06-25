import { z } from "zod";

import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "../../contracts/agent-config.js";
import type { CodeExecutionToolService } from "./CodeExecution.js";
import { readCodeExecutionArguments } from "../../services/runtime/runtime-tool-bridge/arguments.js";
import { EXECUTE_CODE_TOOL_NAME } from "../../services/runtime/runtime-tool-bridge/registry.js";
import { optionalInteger, optionalString } from "../schema-helpers.js";

interface CodeExecutionToolDeps {
  codeExecutionTools: CodeExecutionToolService | null;
  agent: AgentConfig;
}

function resolveWorkspaceRoot(agent: AgentConfig): string | null {
  const value = agent.custom_params?.workspace_root;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

const executeCodeSchema = z.object({
  code: z.string(),
  description: optionalString,
  timeout: optionalInteger,
}).strict();

export function createCodeExecutionTools(deps: CodeExecutionToolDeps): Tool[] {
  const codeExecutionTools = deps.codeExecutionTools;
  const agent = deps.agent;
  if (!codeExecutionTools) {
    return [];
  }
  const enabled = new Set(agent.tools?.enabled_tools ?? []);
  if (!enabled.has(EXECUTE_CODE_TOOL_NAME)) {
    return [];
  }
  const agentWorkspaceRoot = resolveWorkspaceRoot(agent);
  return [
    buildTool({
      name: EXECUTE_CODE_TOOL_NAME,
      description:
        "Execute Python code in a restricted sandbox for data processing and limited tool orchestration. Set result as the final output.",
      source: "execution",
      category: "execution",
      riskLevel: "high",
      allowedCallers: ["direct"],
      extendedUsage: `### 模块与全局变量

- \`result\` — 必须赋值为最终输出
- \`call_tool(tool_name, arguments)\` — 调用其他工具（仅限 \`allowed_callers\` 包含 \`code_execution\` 的工具）

只在需要程序化处理、批量转换或有限工具编排时使用 execute_code。`,
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["code"],
        properties: {
          code: {
            type: "string",
            description: "Python code. Must assign the final output to the result variable.",
          },
          description: {
            type: "string",
            description: "Short purpose of the code execution.",
          },
          timeout: {
            type: "integer",
            minimum: 1,
            maximum: 300,
            description: "Timeout in seconds. Defaults to 60 and is capped at 300.",
          },
        },
      },
      inputSchema: executeCodeSchema,
      isConcurrencySafe: () => false,
      call: (input, ctx: ToolExecContext) =>
        codeExecutionTools.executeCode(readCodeExecutionArguments(input), {
          ...ctx,
          workspaceRoot: ctx.workspaceRoot ?? agentWorkspaceRoot,
        }),
    }),
  ];
}
