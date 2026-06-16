import { z } from "zod";

import type { CodeExecutionToolService } from "../../../tools/code-execution-tool-service.js";
import { readCodeExecutionArguments } from "../../runtime-tool-bridge/arguments.js";
import { EXECUTE_CODE_TOOL_NAME } from "../../runtime-tool-bridge/registry.js";
import { buildTool, type RuntimeTool } from "../tool.js";
import { optionalInteger, optionalString } from "./schema-helpers.js";

interface CodeExecutionToolDeps {
  codeExecutionTools: CodeExecutionToolService | null;
}

const executeCodeSchema = z.object({
  code: z.string(),
  description: optionalString,
  timeout: optionalInteger,
}).strict();

export function createCodeExecutionTools(deps: CodeExecutionToolDeps): RuntimeTool[] {
  const codeExecutionTools = deps.codeExecutionTools;
  if (!codeExecutionTools) {
    return [];
  }
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
      call: (input, context) => codeExecutionTools.executeCode(readCodeExecutionArguments(input), context),
    }),
  ];
}
