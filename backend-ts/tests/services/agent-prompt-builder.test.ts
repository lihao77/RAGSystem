import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { buildFullSystemPrompt } from "../../src/services/agent/prompt-builder/index.js";
import {
  GLOB_TOOL_NAME,
  PREVIEW_DATA_STRUCTURE_TOOL_NAME,
} from "../../src/services/runtime/runtime-tool-bridge/registry.js";
import { DOCUMENT_TOOLS } from "../../src/tools/DocumentTools/DocumentTools.js";
import { LOCAL_SEARCH_TOOLS } from "../../src/tools/LocalSearchTools/LocalSearchTools.js";
import type { RuntimeToolDefinition } from "../../src/services/runtime/runtime-tool-types.js";

const EXECUTE_CODE_TOOL: RuntimeToolDefinition = {
  name: "execute_code",
  description: "Execute Python code in a restricted sandbox.",
  allowed_callers: ["direct"],
  parameters: {
    type: "object",
    required: ["code"],
    properties: { code: { type: "string", description: "Python code." } },
  },
};

describe("agent prompt builder", () => {
  it("renders tool contracts and code-execution callable tools", () => {
    const tools: RuntimeToolDefinition[] = [
      {
        name: "execute_code",
        description: "Execute Python code.",
        allowed_callers: ["direct"],
        extended_usage: "### execute_code usage\nUse `result` for final output.",
        parameters: {
          type: "object",
          required: ["code"],
          properties: {
            code: { type: "string", description: "Python code." },
          },
        },
      },
      {
        name: "read_file",
        description: "Read a file.",
        allowed_callers: ["direct", "code_execution"],
        returns: {
          description: "Returns file text.",
          shape: { content: "..." },
        },
        usage_contract: ["Use line ranges for large files."],
        examples: [
          {
            input: {
              file_path: "src/main.ts",
              notes: "line 1\nline 2",
            },
          },
        ],
        parameters: {
          type: "object",
          required: ["file_path"],
          properties: {
            file_path: { type: "string", description: "File path." },
          },
        },
      },
      {
        name: "execute_bash",
        description: "Execute shell.",
        allowed_callers: ["direct"],
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "Command." },
          },
        },
      },
    ];

    const prompt = buildFullSystemPrompt(minimalAgent(), { tools });

    expect(prompt).toContain("### execute_code usage");
    expect(prompt).toContain("**调用能力**: direct（可直接调用）、code_execution（可在 execute_code 中通过 call_tool 调用）");
    expect(prompt).toContain("**成功返回**:");
    expect(prompt).toContain("Returns file text.");
    expect(prompt).toContain('"content": "..."');
    expect(prompt).toContain("**使用约束**:");
    expect(prompt).toContain("Use line ranges for large files.");
    expect(prompt).toContain("<file_path>src/main.ts</file_path>");
    expect(prompt).toContain("<notes><![CDATA[line 1\nline 2]]></notes>");
    expect(prompt).toContain("在 `execute_code` 的代码中使用 `call_tool(tool_name, arguments)` 时，只能调用以下工具：");
    expect(prompt).toContain("`read_file`");
    expect(prompt).not.toContain("`execute_bash`、");
  });

  it("prefers tool_calls in output format while documenting legacy tools alias", () => {
    const prompt = buildFullSystemPrompt(minimalAgent(), {
      tools: [
        {
          name: "read_file",
          description: "Read file.",
          parameters: {
            type: "object",
            required: ["file_path"],
            properties: { file_path: { type: "string" } },
          },
        },
      ],
    });

    expect(prompt).toContain("## 工作目标");
    expect(prompt).toContain("## 执行原则");
    expect(prompt).toContain("<tool_calls>");
    expect(prompt).toContain("</tool_calls>");
    expect(prompt).toContain("`<tools>` 是兼容旧别名；新输出优先使用 `<tool_calls>`");
    expect(prompt).not.toContain("调用工具：\n<tools>");
    expect(prompt).not.toContain("## Doing tasks");
    expect(prompt).not.toContain("## Executing actions with care");
  });

  it("omits unavailable module guidance from minimal prompts", () => {
    const prompt = buildFullSystemPrompt(minimalAgent(), { tools: [] });

    expect(prompt).not.toContain("request_user_input");
    expect(prompt).not.toContain("execute_code");
    expect(prompt).not.toContain("execute_bash");
    expect(prompt).not.toContain("read_file");
    expect(prompt).not.toContain("preview_data_structure");
    expect(prompt).not.toContain("子 Agent");
    expect(prompt).not.toContain("委派");
    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain('<tool name="tool_name">');
    expect(prompt).not.toContain("数据文件传递规则");
  });

  it("omits background execution guidance unless tasks.background is enabled", () => {
    const disabledPrompt = buildFullSystemPrompt(minimalAgent(), {
      tools: [
        {
          name: "execute_bash",
          description: "Execute shell.",
          parameters: {
            type: "object",
            required: ["command"],
            properties: { command: { type: "string" } },
          },
        },
      ],
    });
    const backgroundAgent = minimalAgent();
    backgroundAgent.tasks = { workflow: false, background: true };
    const enabledPrompt = buildFullSystemPrompt(backgroundAgent, {
      tools: [
        {
          name: "execute_bash",
          description: "Execute shell.",
          parameters: {
            type: "object",
            required: ["command"],
            properties: { command: { type: "string" } },
          },
        },
        {
          name: "task_output",
          description: "Read background output.",
          parameters: {
            type: "object",
            required: ["task_id"],
            properties: { task_id: { type: "string" } },
          },
        },
        {
          name: "task_stop",
          description: "Stop background task.",
          parameters: {
            type: "object",
            required: ["task_id"],
            properties: { task_id: { type: "string" } },
          },
        },
      ],
    });

    expect(disabledPrompt).not.toContain("后台执行");
    expect(disabledPrompt).not.toContain("后台能力");
    expect(disabledPrompt).not.toContain("tasks.background");
    expect(disabledPrompt).not.toContain("run_in_background");
    expect(disabledPrompt).not.toContain("background_task_id");
    expect(disabledPrompt).not.toContain("需要主动查询状态或显式等待时再调用 `task_output`");
    expect(enabledPrompt).toContain("`execute_bash` 支持 `run_in_background=true` 后台执行");
    expect(enabledPrompt).toContain("需要主动查询状态或显式等待时再调用 `task_output`");
  });

  it("keeps special-section tools out of the generic direct tool list", () => {
    const prompt = buildFullSystemPrompt(minimalAgent(), {
      tools: [
        {
          name: "request_user_input",
          description: "Ask user.",
          parameters: {
            type: "object",
            required: ["prompt"],
            properties: { prompt: { type: "string" } },
          },
        },
        {
          name: "call_agent",
          description: "Delegate.",
          parameters: {
            type: "object",
            required: ["agent_name", "task"],
            properties: { agent_name: { type: "string" }, task: { type: "string" } },
          },
        },
        {
          name: "read_file",
          description: "Read file.",
          parameters: {
            type: "object",
            required: ["file_path"],
            properties: { file_path: { type: "string" } },
          },
        },
      ],
    });

    expect(prompt).toContain("### read_file");
    expect(prompt).not.toContain("### request_user_input");
    expect(prompt).not.toContain("### call_agent");
    expect(prompt).toContain('<tool name="request_user_input">');
  });

  it("keeps registry code-execution tool list aligned with runtime allowlist", () => {
    const prompt = buildFullSystemPrompt(minimalAgent(), {
      tools: [
        EXECUTE_CODE_TOOL,
        { ...DOCUMENT_TOOLS.find((tool) => tool.name === PREVIEW_DATA_STRUCTURE_TOOL_NAME)! },
        { ...LOCAL_SEARCH_TOOLS.find((tool) => tool.name === GLOB_TOOL_NAME)! },
      ],
    });

    const codeCallableSection = prompt.slice(prompt.indexOf("## execute_code 中可调用的工具"));
    expect(codeCallableSection).toContain("`preview_data_structure`");
    expect(codeCallableSection).toContain("`glob`");
    expect(codeCallableSection).not.toContain("`read_file`");
    expect(codeCallableSection).not.toContain("`write_file`");
    expect(codeCallableSection).not.toContain("`edit_file`");
  });

  it("renders delegation guidance when delegated agents are present", () => {
    const prompt = buildFullSystemPrompt(minimalAgent(), {
      tools: [
        {
          name: "call_agent",
          description: "Delegate.",
          parameters: {
            type: "object",
            required: ["agent_name", "task"],
            properties: { agent_name: { type: "string" }, task: { type: "string" } },
          },
        },
      ],
      delegatedAgents: [
        {
          agent_name: "plan_agent",
          display_name: "Plan Agent",
          description: "Plan work.",
          use_cases: ["plan"],
          tool_count: 3,
        },
      ],
    });

    expect(prompt).toContain("## 子 Agent 委派");
    expect(prompt).toContain("`plan_agent` (Plan Agent): Plan work.");
    expect(prompt).toContain("use_cases: plan");
    expect(prompt).toContain("<tool name=\"call_agent\">");
    expect(prompt).toContain("<tool name=\"send_message\">");
  });
});

function minimalAgent(): AgentConfig {
  return {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator Agent",
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: {
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        temperature: 0.2,
        max_completion_tokens: 1024,
        extra_params: {},
      },
    },
    tools: { enabled_tools: [] },
    skills: { enabled_skills: [], auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: [],
      write_scopes: [],
      archive_scopes: [],
    },
    tasks: { workflow: false, background: false },
    delegation: { enabled_agents: [] },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: {
      behavior: {
        system_prompt: "You are the core.",
      },
    },
  };
}
