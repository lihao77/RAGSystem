import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { buildFullSystemPrompt, type AgentPromptContext, type RuntimeToolDefinition } from "@ragsystem/agent-sdk";
import {
  GLOB_TOOL_NAME,
  PREVIEW_DATA_STRUCTURE_TOOL_NAME,
} from "../../src/services/runtime/runtime-tool-bridge/registry.js";
import { DOCUMENT_TOOLS } from "../../src/tools/DocumentTools/DocumentTools.js";
import { LOCAL_SEARCH_TOOLS } from "../../src/tools/LocalSearchTools/LocalSearchTools.js";

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

/**
 * 用 SDK buildFullSystemPrompt 构造 prompt（profile 仅投影 behavior；backgroundTasks 按 agent.tasks.background 注入）。
 * 验证 SDK prompt 模块产出与 backend-ts 历史 buildFullSystemPrompt 一致。
 */
function buildPrompt(agent: AgentConfig, context: AgentPromptContext): string {
  const behavior = agent.custom_params.behavior as { system_prompt?: string } | null;
  const promptContext: AgentPromptContext = agent.tasks.background
    ? { ...context, backgroundTasks: true }
    : context;
  return buildFullSystemPrompt({ behavior: { systemPrompt: behavior?.system_prompt ?? "" } }, promptContext, "xml");
}

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

    const prompt = buildPrompt(minimalAgent(), { tools });

    expect(prompt).toContain("### execute_code usage");
    expect(prompt).toContain("**调用能力**: direct（可直接调用）、code_execution（可在 execute_code 中通过 call_tool 调用）");
    expect(prompt).toContain("**成功返回**:");
    expect(prompt).toContain("Returns file text.");
    expect(prompt).toContain('"content": "..."');
    expect(prompt).toContain("**使用约束**:");
    expect(prompt).toContain("Use line ranges for large files.");
    expect(prompt).toContain("<file_path>src/main.ts</file_path>");
    expect(prompt).toContain("<notes><![CDATA[line 1\nline 2]]></notes>");
    expect(prompt).toContain("标注 `code_execution` 的工具仅可在 `execute_code` 中通过 `call_tool(tool_name, arguments)` 调用");
  });

  it("prefers tool_calls in output format while documenting legacy tools alias", () => {
    const prompt = buildPrompt(minimalAgent(), {
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
    const prompt = buildPrompt(minimalAgent(), { tools: [] });

    expect(prompt).not.toContain("request_user_input");
    expect(prompt).not.toContain("execute_code");
    expect(prompt).not.toContain("execute_bash");
    expect(prompt).not.toContain("read_file");
    expect(prompt).not.toContain("preview_data_structure");
    expect(prompt).not.toContain("子 Agent");
    expect(prompt).not.toContain("委派");
    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain('<tool name="tool_name">');
  });

  it("renders all tools uniformly in the direct tool list", () => {
    const prompt = buildPrompt(minimalAgent(), {
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
    expect(prompt).toContain("### request_user_input");
    expect(prompt).toContain("### call_agent");
  });

  it("renders delegation guidance as call_agent self-description in the tools section", () => {
    // delegation 不再有独立 section：可委派清单与委派语义由 call_agent 工具自描述
    // （agent_name enum + extended_usage + examples），统一进 ## 可直接调用的工具 段。
    const prompt = buildPrompt(minimalAgent(), {
      tools: [
        {
          name: "call_agent",
          description: "Delegate.",
          allowed_callers: ["direct"],
          parameters: {
            type: "object",
            required: ["agent_name", "task"],
            properties: {
              agent_name: {
                type: "string",
                enum: ["plan_agent"],
                description: "Target child Agent name from the current delegation allowlist.",
              },
              task: { type: "string" },
            },
          },
          extended_usage: [
            "可委派子 Agent：",
            "- `plan_agent` (Plan Agent): Plan work.",
            "  - use_cases: plan",
          ].join("\n"),
          examples: [
            {
              input: {
                agent_name: "plan_agent",
                task: "draft a plan",
              },
            },
          ],
        },
      ],
    });

    expect(prompt).not.toContain("## 子 Agent 委派");
    expect(prompt).toContain("### call_agent");
    expect(prompt).toContain("`plan_agent` (Plan Agent): Plan work.");
    expect(prompt).toContain("use_cases: plan");
    expect(prompt).toContain("<tool name=\"call_agent\">");
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
