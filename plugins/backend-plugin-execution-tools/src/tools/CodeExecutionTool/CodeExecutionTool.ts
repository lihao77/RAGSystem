import { z } from "zod";

import { buildTool, type Tool, type ToolExecContext } from "@ragsystem/agent-sdk";
import type { AgentConfig } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { CodeExecutionPort } from "../../contracts.js";
import { readCodeExecutionArguments } from "../arguments.js";
import { optionalInteger, optionalString } from "@ragsystem/backend-core/tools/schema-helpers.js";

const EXECUTE_CODE_TOOL_NAME = "execute_code";

interface CodeExecutionToolDeps {
  codeExecutionTools: CodeExecutionPort | null;
  agent: AgentConfig;
  callTool?: (toolName: string, args: Record<string, unknown>, context: ToolExecContext) => Promise<import("@ragsystem/agent-sdk").ToolExecutionResult>;
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
        "Execute Python code from the shared Local workspace for data processing and tool orchestration. Set result as the final output.",
      source: "execution",
      category: "execution",
      riskLevel: "high",
      allowedCallers: ["direct"],
      extendedUsage: `### 模块与全局变量

- \`result\` — 必须赋值为最终输出
- \`call_tool(tool_name, arguments)\` — 调用其他工具（仅限 \`allowed_callers\` 包含 \`code_execution\` 的工具）
- Local 阶段使用标准 Python 运行时：可正常导入标准库（例如 \`html\`、\`os\`），\`os.getcwd()\` 是共享 workspace
- 相对路径默认相对 workspace；可通过 \`os.environ["SESSION_*_DIR"]\` 或同名全局变量访问 workspace、uploads、artifacts、transient
- \`path_ops\` 提供四个目录常量；Local 当前是宿主机直执行，不提供 OS 级隔离

只在需要程序化处理、批量转换或工具编排时使用 execute_code。`,
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
        }, deps.callTool ?? null),
    }),
  ];
}
