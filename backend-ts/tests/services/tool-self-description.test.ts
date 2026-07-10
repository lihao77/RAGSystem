import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import { SkillToolService } from "../../src/tools/SkillTools/SkillExecution.js";
import { createSkillTools } from "../../src/tools/SkillTools/SkillTools.js";
import { createDelegationTools } from "../../src/tools/DelegationTools/DelegationTools.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("skill tool self-description", () => {
  it("activate_skill carries the visible Skill list as enum + extended_usage", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-skill-factory-"));
    tempRoots.push(root);
    const builtinRoot = path.join(root, "builtin");
    writeSkill(path.join(builtinRoot, "viz"), "viz", "可视化场景", "# Viz\n");
    writeSkill(path.join(builtinRoot, "etl"), "etl", "数据清洗", "# ETL\n");
    const skillTools = new SkillToolService({ dataRoot: root, builtinSkillsRoot: builtinRoot, userGlobalSkillsRoot: path.join(root, "global") });
    const agent = skillAgent(["viz", "etl"]);

    const tools = createSkillTools({ skillTools, agent });
    expect(tools.map((tool) => tool.name)).not.toContain("get_skill_info");
    const activate = tools.find((tool) => tool.name === "activate_skill");
    expect(activate).toBeTruthy();

    const activateSkillName = (activate!.parameters.properties as Record<string, { enum?: string[] }>).skill_name;
    expect(activateSkillName!.enum).toEqual(["etl", "viz"]);
    expect(activate!.extendedUsage).toContain("### Skill: viz");
    expect(activate!.extendedUsage).toContain("可视化场景");
    expect(activate!.extendedUsage).toContain("### Skill: etl");
  });

  it("returns no tools when no Skill is visible", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-skill-factory-empty-"));
    tempRoots.push(root);
    const skillTools = new SkillToolService({ dataRoot: root, builtinSkillsRoot: path.join(root, "builtin"), userGlobalSkillsRoot: path.join(root, "global") });
    expect(createSkillTools({ skillTools, agent: skillAgent([]) })).toEqual([]);
  });
});

describe("delegation tool self-description", () => {
  it("call_agent carries allowlist (enum + extended_usage) and examples", () => {
    const agent = delegationAgent(["plan_agent", "worker_agent"]);
    const lookup = {
      getConfig: (name: string): AgentConfig | null => ({
        ...delegationAgent([]),
        agent_name: name,
        display_name: name === "plan_agent" ? "Plan Agent" : "Worker Agent",
        description: name === "plan_agent" ? "Plan work." : "Execute work.",
        custom_params: { behavior: { use_cases: name === "plan_agent" ? ["plan"] : ["execute"] } },
      }),
    };

    const tools = createDelegationTools({
      agent,
      teamName: null,
      getAgentDelegation: () => ({}) as never,
      agentConfig: lookup,
    });
    const callAgent = tools.find((tool) => tool.name === "call_agent");
    const sendMessage = tools.find((tool) => tool.name === "send_message");
    const listChild = tools.find((tool) => tool.name === "list_child_agents");
    expect(callAgent).toBeTruthy();
    expect(sendMessage).toBeTruthy();
    expect(listChild).toBeTruthy();

    const agentNameParam = (callAgent!.parameters.properties as Record<string, { enum?: string[] }>).agent_name;
    expect(agentNameParam!.enum).toEqual(["plan_agent", "worker_agent"]);
    expect(callAgent!.extendedUsage).toContain("可委派子 Agent：");
    expect(callAgent!.extendedUsage).toContain("`plan_agent` (Plan Agent): Plan work.");
    expect(callAgent!.extendedUsage).toContain("use_cases: plan");
    expect(callAgent!.examples).toEqual([
      { input: expect.objectContaining({ agent_name: "plan_agent" }) },
    ]);

    // list_child_agents 的 agent_name 也带 enum
    expect((listChild!.parameters.properties as Record<string, { enum?: string[] }>).agent_name!.enum).toEqual(["plan_agent", "worker_agent"]);

    // send_message 自描述续接语义 + 示例
    expect(sendMessage!.extendedUsage).toContain("child_agent_id");
    expect(sendMessage!.examples).toEqual([
      { input: expect.objectContaining({ child_agent_id: "{result_1.content.items.0.child_agent_id}" }) },
    ]);
  });

  it("returns no tools when delegation not enabled", () => {
    const agent = delegationAgent([]);
    expect(
      createDelegationTools({
        agent,
        teamName: null,
        getAgentDelegation: () => ({}) as never,
        agentConfig: { getConfig: () => null },
      }),
    ).toEqual([]);
  });
});

function writeSkill(skillDir: string, name: string, description: string, body: string): void {
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
    "utf8",
  );
}

function skillAgent(enabledSkills: string[]): AgentConfig {
  return {
    agent_name: "skill_agent",
    enabled: true,
    default_entry: false,
    tools: { enabled_tools: [] },
    skills: { enabled_skills: enabledSkills, auto_inject: true },
    mcp: { enabled_servers: [] },
    memory: { auto_inject: true, allowed_scopes: [], write_scopes: [], archive_scopes: [] },
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
    custom_params: {},
  };
}

function delegationAgent(enabledAgents: string[]): AgentConfig {
  return {
    ...skillAgent([]),
    agent_name: "orchestrator",
    delegation: { enabled_agents: enabledAgents },
  };
}
