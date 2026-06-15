import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { AgentDelegationService } from "../../src/services/agent/agent-delegation-service.js";
import type { ToolExecutionResult } from "../../src/services/runtime/runtime-tool-types.js";
import { DelegationToolProvider } from "../../src/services/runtime/runtime-tool-providers/delegation-tool-provider.js";

describe("DelegationToolProvider", () => {
  it("lists delegation tools only when service and allowed child agents are present", () => {
    const withService = new DelegationToolProvider(() => fakeDelegation());
    const withoutService = new DelegationToolProvider(() => null);

    expect(withService.listTools({ agent: minimalAgent([]) })).toEqual([]);
    expect(withoutService.listTools({ agent: minimalAgent(["plan_agent"]) })).toEqual([]);
    expect(withService.listTools({ agent: minimalAgent(["plan_agent"]) }).map((tool) => tool.name)).toEqual([
      "call_agent",
      "list_child_agents",
      "send_message",
    ]);
  });

  it("dispatches delegation calls through the provider protocol", async () => {
    const calls: Array<{ method: string; input: unknown; toolCallId?: string | null | undefined }> = [];
    const provider = new DelegationToolProvider(() => fakeDelegation(calls));

    expect(provider.canHandle("call_agent")).toBe(true);
    expect(provider.canHandle("read_file")).toBe(false);

    const callResult = await Promise.resolve(provider.executeTool({
      toolName: "call_agent",
      callId: "delegate-1",
      arguments: {
        agent_name: "plan_agent",
        task: "plan",
        context_hint: "short",
      },
    }, { agent: minimalAgent(["plan_agent"]), toolCallId: "ctx-call" }));
    const listResult = await Promise.resolve(provider.executeTool({
      toolName: "list_child_agents",
      arguments: { agent_name: "plan_agent", limit: 5 },
    }, { agent: minimalAgent(["plan_agent"]) }));
    const sendResult = await Promise.resolve(provider.executeTool({
      toolName: "send_message",
      callId: "send-1",
      arguments: {
        child_agent_id: "child-1",
        message: "continue",
      },
    }, { agent: minimalAgent(["plan_agent"]) }));

    expect(calls).toEqual([
      {
        method: "callAgent",
        input: {
          agentName: "plan_agent",
          task: "plan",
          contextHint: "short",
          callId: "ctx-call",
        },
        toolCallId: "ctx-call",
      },
      {
        method: "listChildAgents",
        input: {
          agentName: "plan_agent",
          limit: 5,
        },
      },
      {
        method: "sendMessage",
        input: {
          childAgentId: "child-1",
          message: "continue",
          callId: "send-1",
        },
      },
    ]);
    expect(callResult).toMatchObject({ success: true, tool_name: "call_agent" });
    expect(listResult).toMatchObject({ success: true, tool_name: "list_child_agents" });
    expect(sendResult).toMatchObject({ success: true, tool_name: "send_message" });
  });
});

function fakeDelegation(calls: Array<{ method: string; input: unknown; toolCallId?: string | null | undefined }> = []): AgentDelegationService {
  return {
    callAgent(input: unknown, context: { toolCallId?: string | null }) {
      calls.push({ method: "callAgent", input, toolCallId: context.toolCallId });
      return success("call_agent");
    },
    listChildAgents(input: unknown) {
      calls.push({ method: "listChildAgents", input });
      return success("list_child_agents");
    },
    sendMessage(input: unknown) {
      calls.push({ method: "sendMessage", input });
      return success("send_message");
    },
  } as unknown as AgentDelegationService;
}

function success(toolName: string): ToolExecutionResult<string> {
  return {
    success: true,
    tool_name: toolName,
    summary: "ok",
    answer: null,
    output_type: "text",
    content: "ok",
    metadata: {},
    artifacts: [],
    llm_hint: null,
  };
}

function minimalAgent(enabledAgents: string[]): AgentConfig {
  return {
    agent_name: "orchestrator_agent",
    display_name: "Orchestrator Agent",
    description: null,
    enabled: true,
    default_entry: true,
    llm_tiers: null,
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
    delegation: { enabled_agents: enabledAgents },
    knowledge_base: {
      enabled: false,
      default_collection: "documents",
      default_search_mode: "hybrid",
      default_top_k: 5,
      default_rerank: false,
      default_reranker_key: null,
    },
    custom_params: {},
  };
}
