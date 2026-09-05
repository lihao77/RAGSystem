import { describe, expect, it } from "vitest";

import { AgentConfigSchema } from "../src/contracts/agent/agent-config.js";
import { isAgentConfigChangedEvent } from "../src/contracts/agent/agent-config-events.js";
import {
  canonicalizeEnabledToolNames,
  normalizeConfig,
  stripConfigManagedToolNames,
} from "../src/contracts/agent/config-normalize.js";
import { registerRetiredToolNames } from "../src/contracts/agent/tool-name-aliases.js";

// 退役名是插件知识：单测环境无插件注册，按执行工具插件描述符的声明方式注册，
// 验证的正是"插件声明改名 → core 归一层收敛存量配置"这条链路。
registerRetiredToolNames("execute_shell", ["execute_bash"]);

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

  it("renames retired execute_bash tool to execute_shell on load and update paths", () => {
    // 历史形状：改名前落盘的 enabled_tools 携带 execute_bash；可能新旧名并存（半迁移状态）。
    const historical = normalizeConfig(AgentConfigSchema.parse({
      agent_name: "legacy",
      tools: { enabled_tools: ["read_file", "execute_bash", "glob"] },
    }));
    expect(historical.tools.enabled_tools).toEqual(["read_file", "execute_shell", "glob"]);

    const halfMigrated = normalizeConfig(AgentConfigSchema.parse({
      agent_name: "half",
      tools: { enabled_tools: ["execute_shell", "execute_bash", "read_file"] },
    }));
    expect(halfMigrated.tools.enabled_tools).toEqual(["execute_shell", "read_file"]);

    // 已是现名的配置不被改写。
    expect(canonicalizeEnabledToolNames(["read_file", "execute_shell"])).toEqual(["read_file", "execute_shell"]);
  });
});
