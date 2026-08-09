import { describe, expect, it } from "vitest";
import { createToolRegistry } from "@ragsystem/agent-sdk";

import { AgentConfigSchema } from "../src/contracts/agent/agent-config.js";
import { createDelegationTools } from "../src/tools/DelegationTools/DelegationTools.js";
import { AGENT_TOOL_NAME } from "../src/services/runtime/runtime-tool-bridge/registry.js";
import type { DelegationPort } from "../src/services/agent/delegation/port.js";

function delegationTool() {
  const agent = AgentConfigSchema.parse({
    agent_name: "parent",
    delegation: { enabled_agents: ["worker"] },
  });
  const tool = createDelegationTools({
    agent,
    teamName: null,
    getAgentDelegation: () => ({} as DelegationPort),
  }).find((item) => item.name === AGENT_TOOL_NAME);
  if (!tool) throw new Error("agent delegation tool was not created");
  return tool;
}

describe("agent delegation concurrency key", () => {
  it("normalizes snake_case and camelCase child ids and ignores message text", () => {
    const registry = createToolRegistry({ tools: [delegationTool()] });

    const snakeCase = registry.concurrencyKey(AGENT_TOOL_NAME, {
      child_agent_id: "child-worker",
      message: "first request",
    });
    const camelCase = registry.concurrencyKey(AGENT_TOOL_NAME, {
      childAgentId: "child-worker",
      message: "different request",
    });

    expect(snakeCase).toBe("agent:child-worker");
    expect(camelCase).toBe(snakeCase);
  });

  it("normalizes agent name and uses child id when both routes are present", () => {
    const registry = createToolRegistry({ tools: [delegationTool()] });

    expect(registry.concurrencyKey(AGENT_TOOL_NAME, {
      agent_name: "worker",
      message: "snake request",
    })).toBe("agent:worker");
    expect(registry.concurrencyKey(AGENT_TOOL_NAME, {
      agentName: "worker",
      message: "camel request",
    })).toBe("agent:worker");
    expect(registry.concurrencyKey(AGENT_TOOL_NAME, {
      agentName: "worker",
      child_agent_id: "child-worker",
      message: "child route wins",
    })).toBe("agent:child-worker");
  });

  it("uses a stable parent route key when no child target is supplied", () => {
    const registry = createToolRegistry({ tools: [delegationTool()] });

    expect(registry.concurrencyKey(AGENT_TOOL_NAME, {
      message: "parent request",
    })).toBe("agent:parent");
  });
});
