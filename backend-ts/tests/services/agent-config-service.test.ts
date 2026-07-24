import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { AgentConfigService } from "../../src/services/agent/config/index.js";
import { FileAgentConfigTeamStore } from "../../src/adapters/filesystem/agent/file-team-store.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentConfigService team file compatibility", () => {
  it("migrates legacy tasks.workflow into goals.enabled", async () => {
    const dataRoot = makeTempDataRoot();
    writeTeamIndex(dataRoot, {
      active_team: "default",
      teams: { default: "teams/default.yaml" },
    });
    writeTeam(dataRoot, "default", {
      legacy_agent: {
        ...minimalAgent("legacy_agent", true),
        tasks: { workflow: true, background: true },
      },
    });

    const service = await makeService(dataRoot);

    expect(service.getConfig("legacy_agent")).toMatchObject({
      goals: { enabled: true },
      tasks: { background: true },
    });
  });

  it("loads Python-compatible team_index.yaml and active team YAML", async () => {
    const dataRoot = makeTempDataRoot();
    writeTeamIndex(dataRoot, {
      active_team: "default",
      teams: {
        default: "teams/default.yaml",
      },
    });
    writeTeam(dataRoot, "default", {
      orchestrator_agent: {
        agent_name: "orchestrator_agent",
        display_name: "Orchestrator Agent",
        enabled: true,
        default_entry: true,
        llm_tiers: {
          default: {
            provider: "rag",
            provider_type: "deepseek",
            model_name: "deepseek-v4-pro",
            temperature: 0.2,
            max_completion_tokens: 4096,
            max_context_tokens: 128000,
            extra_params: {},
          },
        },
        tools: { enabled_tools: ["read_file"] },
        skills: { enabled_skills: ["visualization"] },
        mcp: { enabled_servers: ["codex"] },
        memory: {
          auto_inject: true,
          allowed_scopes: ["team", "session", "agent", "workspace"],
          write_scopes: ["session"],
          archive_scopes: ["session"],
        },
        goals: { enabled: true },
        tasks: { background: true },
        delegation: { enabled_agents: [] },
        knowledge_base: {
          enabled: true,
          default_collection: "documents",
          default_search_mode: "hybrid",
          default_top_k: 5,
          default_rerank: true,
          default_reranker_key: null,
        },
        custom_params: {
          behavior: {
            system_prompt: "shared prompt",
          },
        },
      },
    });

    const service = await makeService(dataRoot);

    expect(await service.listTeams()).toMatchObject({
      active_team: "default",
      teams: [
        {
          team_name: "default",
          file_path: "teams/default.yaml",
          agent_count: 1,
          agents: ["orchestrator_agent"],
        },
      ],
    });
    expect(service.getConfig("orchestrator_agent")).toMatchObject({
      agent_name: "orchestrator_agent",
      default_entry: true,
      llm_tiers: {
        default: {
          provider: "rag",
          provider_type: "deepseek",
          model_name: "deepseek-v4-pro",
        },
      },
      custom_params: {
        behavior: {
          system_prompt: "shared prompt",
        },
      },
    });
  });

  it("strips config-managed tools from loaded and patched enabled_tools", async () => {
    const dataRoot = makeTempDataRoot();
    writeTeamIndex(dataRoot, {
      active_team: "default",
      teams: {
        default: "teams/default.yaml",
      },
    });
    writeTeam(dataRoot, "default", {
      general_agent: {
        ...minimalAgent("general_agent", true),
        tools: {
          enabled_tools: [
            "read_file",
            "todo_write",
            "task_create",
            "task_stop",
            "activate_skill",
            "search_knowledge_base",
            "call_agent",
          ],
        },
      },
    });

    const service = await makeService(dataRoot);

    expect(service.getConfig("general_agent")?.tools.enabled_tools).toEqual(["read_file", "todo_write"]);
    const patched = await service.patchConfig("general_agent", {
      tools: {
        enabled_tools: ["write_file", "task_update", "execute_skill_script", "list_child_agents"],
      },
    });
    expect(patched?.tools.enabled_tools).toEqual(["write_file"]);

    const team = readYaml(path.join(dataRoot, "config", "agents", "teams", "default.yaml"));
    const agent = getRecord(getRecord(team, "agents"), "general_agent");
    expect(agent.tools).toEqual({ enabled_tools: ["write_file"] });
  });

  it("persists active team and config updates to the shared YAML files", async () => {
    const dataRoot = makeTempDataRoot();
    writeTeamIndex(dataRoot, {
      active_team: "default",
      teams: {
        default: "teams/default.yaml",
      },
    });
    writeTeam(dataRoot, "default", {
      general_agent: minimalAgent("general_agent", true),
    });

    const service = await makeService(dataRoot);
    await service.createTeam("research", "default");
    await service.activateTeam("research");
    await service.patchConfig("general_agent", {
      llm_tiers: {
        default: {
          provider: "rag",
          provider_type: "deepseek",
          model_name: "deepseek-v4-flash",
        },
      },
    });

    const index = readYaml(path.join(dataRoot, "config", "agents", "team_index.yaml"));
    expect(index).toMatchObject({
      active_team: "research",
      teams: {
        default: "teams/default.yaml",
        research: "teams/research.yaml",
      },
    });
    const research = readYaml(path.join(dataRoot, "config", "agents", "teams", "research.yaml"));
    expect(research).toMatchObject({
      agents: {
        general_agent: {
          llm_tiers: {
            default: {
              provider: "rag",
              provider_type: "deepseek",
              model_name: "deepseek-v4-flash",
            },
          },
        },
      },
      metadata: {
        version: "2.0",
      },
    });
    expect(typeof getPath(research, ["metadata", "updated_at"])).toBe("string");
  });

  it("persists agent deletion to the active shared team file", async () => {
    const dataRoot = makeTempDataRoot();
    writeTeamIndex(dataRoot, {
      active_team: "default",
      teams: {
        default: "teams/default.yaml",
      },
    });
    writeTeam(dataRoot, "default", {
      general_agent: minimalAgent("general_agent", false),
      orchestrator_agent: minimalAgent("orchestrator_agent", true),
    });

    const service = await makeService(dataRoot);

    expect(await service.deleteAgent("general_agent")).toBe(true);
    const team = readYaml(path.join(dataRoot, "config", "agents", "teams", "default.yaml"));
    const agents = getRecord(team, "agents");
    expect(agents.general_agent).toBeUndefined();
    expect(agents.orchestrator_agent).toBeDefined();
  });

  it("cascades deletion to purge dangling delegation references", async () => {
    const dataRoot = makeTempDataRoot();
    writeTeamIndex(dataRoot, {
      active_team: "default",
      teams: {
        default: "teams/default.yaml",
      },
    });
    writeTeam(dataRoot, "default", {
      general_agent: minimalAgent("general_agent", false),
      research_agent: minimalAgent("research_agent", false),
      orchestrator_agent: {
        ...minimalAgent("orchestrator_agent", true),
        delegation: { enabled_agents: ["general_agent", "research_agent"] },
      },
    });

    const service = await makeService(dataRoot);

    expect(await service.deleteAgent("general_agent")).toBe(true);

    // 内存中：对已删除 agent 的委派引用被清理，对其余 agent 的引用保留
    const orchestrator = service.getConfig("orchestrator_agent");
    expect(orchestrator?.delegation.enabled_agents).toEqual(["research_agent"]);

    // 持久化：落盘的 default.yaml 同样不含悬空引用
    const team = readYaml(path.join(dataRoot, "config", "agents", "teams", "default.yaml"));
    const persistedOrchestrator = getRecord(team, "agents").orchestrator_agent as Record<string, unknown>;
    expect(getRecord(persistedOrchestrator, "delegation").enabled_agents).toEqual(["research_agent"]);
  });

  it("self-heals dangling delegation references on load", async () => {
    const dataRoot = makeTempDataRoot();
    writeTeamIndex(dataRoot, {
      active_team: "default",
      teams: {
        default: "teams/default.yaml",
      },
    });
    // 磁盘上残留历史脏数据：orchestrator 委派给已被删除的 ghost_agent 和仍存在的 research_agent
    writeTeam(dataRoot, "default", {
      research_agent: minimalAgent("research_agent", false),
      orchestrator_agent: {
        ...minimalAgent("orchestrator_agent", true),
        delegation: { enabled_agents: ["ghost_agent", "research_agent"] },
      },
    });

    const service = await makeService(dataRoot);

    // 内存中：悬空引用被剔除，合法引用保留
    const orchestrator = service.getConfig("orchestrator_agent");
    expect(orchestrator?.delegation.enabled_agents).toEqual(["research_agent"]);

    // 一次性回写：磁盘上的脏数据同样被清理
    const team = readYaml(path.join(dataRoot, "config", "agents", "teams", "default.yaml"));
    const persistedOrchestrator = getRecord(team, "agents").orchestrator_agent as Record<string, unknown>;
    expect(getRecord(persistedOrchestrator, "delegation").enabled_agents).toEqual(["research_agent"]);
  });

  it("renames and deletes team files like the Python manager", async () => {
    const dataRoot = makeTempDataRoot();
    writeTeamIndex(dataRoot, {
      active_team: "default",
      teams: {
        default: "teams/default.yaml",
      },
    });
    writeTeam(dataRoot, "default", {
      general_agent: minimalAgent("general_agent", true),
    });

    const service = await makeService(dataRoot);
    await service.createTeam("research work", "default");
    const researchPath = path.join(dataRoot, "config", "agents", "teams", "research-work.yaml");
    expect(fs.existsSync(researchPath)).toBe(true);

    await service.renameTeam("research work", "final team");
    const finalPath = path.join(dataRoot, "config", "agents", "teams", "final-team.yaml");
    expect(fs.existsSync(researchPath)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(readYaml(path.join(dataRoot, "config", "agents", "team_index.yaml"))).toMatchObject({
      teams: {
        default: "teams/default.yaml",
        "final team": "teams/final-team.yaml",
      },
    });

    await service.deleteTeam("final team");
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(readYaml(path.join(dataRoot, "config", "agents", "team_index.yaml"))).toMatchObject({
      teams: {
        default: "teams/default.yaml",
      },
    });
  });
});

async function makeService(dataRoot: string): Promise<AgentConfigService> {
  const service = new AgentConfigService(new FileAgentConfigTeamStore({ dataRoot }));
  await service.initialize();
  return service;
}

function makeTempDataRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ragsystem-agent-config-"));
  tempRoots.push(root);
  return root;
}

function writeTeamIndex(dataRoot: string, payload: Record<string, unknown>): void {
  const filePath = path.join(dataRoot, "config", "agents", "team_index.yaml");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, YAML.stringify(payload), "utf8");
}

function writeTeam(dataRoot: string, teamName: string, agents: Record<string, unknown>): void {
  const filePath = path.join(dataRoot, "config", "agents", "teams", `${teamName}.yaml`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    YAML.stringify({
      agents,
      metadata: {
        updated_at: "2026-01-01T00:00:00",
        version: "2.0",
      },
    }),
    "utf8",
  );
}

function minimalAgent(agentName: string, defaultEntry: boolean): Record<string, unknown> {
  return {
    agent_name: agentName,
    enabled: true,
    default_entry: defaultEntry,
    llm_tiers: {
      default: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
      },
    },
    custom_params: {
      behavior: {
        system_prompt: "test prompt",
      },
    },
  };
}

function readYaml(filePath: string): Record<string, unknown> {
  const parsed = YAML.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath} did not contain an object`);
  }
  return parsed as Record<string, unknown>;
}

function getRecord(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const child = value[key];
  if (!child || typeof child !== "object" || Array.isArray(child)) {
    throw new Error(`${key} did not contain an object`);
  }
  return child as Record<string, unknown>;
}

function getPath(value: Record<string, unknown>, keys: string[]): unknown {
  let current: unknown = value;
  for (const key of keys) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}
