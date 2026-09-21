import { describe, expect, it } from "vitest";

import {
  AGENT_CAPABILITY_ID_PATTERN,
  agentCapabilityToken,
  listAgentCapabilityProviders,
  provideAgentCapability,
} from "../src/plugins/agent-capability-provider.js";
import { CapabilityRegistry } from "../src/plugins/capability-registry.js";

function fakeProvider(id: string) {
  return {
    id,
    display_name: `Provider ${id}`,
    listItems: async () => [{ name: `${id}-one` }, { name: `${id}-two` }],
    getAgentConfig: async () => [] as string[],
    putAgentConfig: async () => undefined,
  };
}

describe("agent capability provider contract", () => {
  it("rejects provider ids outside the stable pattern", () => {
    expect(() => agentCapabilityToken("Skills")).toThrow(/must match/);
    expect(() => agentCapabilityToken("1skills")).toThrow(/must match/);
    expect(() => agentCapabilityToken("")).toThrow(/must match/);
    expect(agentCapabilityToken("planning_agents").id).toBe("agent-capability/planning_agents");
    expect(AGENT_CAPABILITY_ID_PATTERN.test("mcp")).toBe(true);
  });

  it("enumerates registered providers by token prefix and sorts by id", () => {
    const registry = new CapabilityRegistry([
      provideAgentCapability(fakeProvider("mcp")),
      provideAgentCapability(fakeProvider("skills")),
    ]);
    expect(listAgentCapabilityProviders(registry).map((provider) => provider.id)).toEqual(["mcp", "skills"]);
  });

  it("skips capability ids under the prefix that do not satisfy the provider shape", () => {
    const registry = new CapabilityRegistry();
    registry.provide(agentCapabilityToken("broken"), { id: "broken" } as never);
    registry.provide(agentCapabilityToken("skills"), fakeProvider("skills"));
    expect(listAgentCapabilityProviders(registry).map((provider) => provider.id)).toEqual(["skills"]);
  });

  it("ignores capabilities outside the agent-capability prefix", () => {
    const registry = new CapabilityRegistry();
    registry.provide({ id: "skills-runtime" }, fakeProvider("skills"));
    expect(listAgentCapabilityProviders(registry)).toEqual([]);
  });

  it("treats getItemDetail as optional: providers with and without it both pass the shape check", () => {
    const withDetail = {
      ...fakeProvider("mcp"),
      getItemDetail: async (name: string) => (name === "github" ? { name, detail: { tools: [] } } : null),
    };
    const registry = new CapabilityRegistry([
      provideAgentCapability(withDetail),
      provideAgentCapability(fakeProvider("skills")),
    ]);
    const providers = listAgentCapabilityProviders(registry);
    expect(providers.map((provider) => typeof provider.getItemDetail)).toEqual(["function", "undefined"]);
    const [mcpProvider] = providers;
    expect(mcpProvider).toBeDefined();
    expect(mcpProvider?.getItemDetail?.("github")).resolves.toEqual({ name: "github", detail: { tools: [] } });
    expect(mcpProvider?.getItemDetail?.("missing")).resolves.toBeNull();
  });
});
