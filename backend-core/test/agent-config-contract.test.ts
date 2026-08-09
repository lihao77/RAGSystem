import { describe, expect, it } from "vitest";

import { AgentConfigSchema } from "../src/contracts/agent/agent-config.js";
import { isAgentConfigChangedEvent } from "../src/contracts/agent/agent-config-events.js";
import {
  normalizeConfig,
  stripConfigManagedToolNames,
} from "../src/contracts/agent/config-normalize.js";

describe("core Agent config contract", () => {
  it("recognizes generic Agent configuration change events", () => {
    expect(isAgentConfigChangedEvent({
      tenantId: "tenant-a",
      teamName: "default",
      change: "updated",
    })).toBe(true);
    expect(isAgentConfigChangedEvent({
      tenantId: "tenant-a",
      teamName: "renamed",
      change: "updated",
      previousTeamName: "original",
    })).toBe(true);
    expect(isAgentConfigChangedEvent({
      tenantId: "tenant-a",
      teamName: "obsolete",
      change: "deleted",
    })).toBe(true);
    expect(isAgentConfigChangedEvent({ tenantId: "", teamName: "default", change: "updated" })).toBe(false);
    expect(isAgentConfigChangedEvent({
      tenantId: "tenant-a",
      teamName: "renamed",
      change: "updated",
      previousTeamName: " ",
    })).toBe(false);
  });

  it("strips plugin-owned root configuration", () => {
    const config = AgentConfigSchema.parse({
      agent_name: "writer",
      skills: { enabled_skills: ["review-code"] },
      memory: { enabled: true },
      knowledge_base: { enabled: true },
      mcp: { enabled_servers: ["docs"] },
    });

    expect(config).not.toHaveProperty("skills");
    expect(config).not.toHaveProperty("memory");
    expect(config).not.toHaveProperty("knowledge_base");
    expect(config).not.toHaveProperty("mcp");
  });

  it("preserves plugin tool names while removing core-managed tools", () => {
    expect(stripConfigManagedToolNames([
      "read_file",
      "goal_create",
      "agent",
      "activate_skill",
      "search_knowledge_base",
    ])).toEqual(["read_file", "activate_skill", "search_knowledge_base"]);
  });

  it("migrates legacy workflow capability into goal mode", () => {
    const config = normalizeConfig(AgentConfigSchema.parse({
      agent_name: "legacy",
      tasks: { workflow: true, background: true },
    }));

    expect(config.goals.enabled).toBe(true);
    expect(config.tasks.background).toBe(true);
  });
});
