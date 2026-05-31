import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import YAML from "yaml";

import { AgentConfigService } from "../../src/services/agent-config-service.js";

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("AgentConfigService team file compatibility", () => {
  it("loads Python-compatible team_index.yaml and active team YAML", () => {
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
        skills: { enabled_skills: ["visualization"], auto_inject: true },
        mcp: { enabled_servers: ["codex"] },
        memory: {
          auto_inject: true,
          allowed_scopes: ["team", "session", "agent", "workspace"],
          write_scopes: ["session"],
          archive_scopes: ["session"],
        },
        tasks: { workflow: true, background: true },
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

    const service = new AgentConfigService({ dataRoot });

    expect(service.listTeams()).toMatchObject({
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

  it("persists active team and config updates to the shared YAML files", () => {
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

    const service = new AgentConfigService({ dataRoot });
    service.createTeam("research", "default");
    service.activateTeam("research");
    service.patchConfig("general_agent", {
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

  it("persists agent deletion to the active shared team file", () => {
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

    const service = new AgentConfigService({ dataRoot });

    expect(service.deleteAgent("general_agent")).toBe(true);
    const team = readYaml(path.join(dataRoot, "config", "agents", "teams", "default.yaml"));
    const agents = getRecord(team, "agents");
    expect(agents.general_agent).toBeUndefined();
    expect(agents.orchestrator_agent).toBeDefined();
  });

  it("renames and deletes team files like the Python manager", () => {
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

    const service = new AgentConfigService({ dataRoot });
    service.createTeam("research work", "default");
    const researchPath = path.join(dataRoot, "config", "agents", "teams", "research-work.yaml");
    expect(fs.existsSync(researchPath)).toBe(true);

    service.renameTeam("research work", "final team");
    const finalPath = path.join(dataRoot, "config", "agents", "teams", "final-team.yaml");
    expect(fs.existsSync(researchPath)).toBe(false);
    expect(fs.existsSync(finalPath)).toBe(true);
    expect(readYaml(path.join(dataRoot, "config", "agents", "team_index.yaml"))).toMatchObject({
      teams: {
        default: "teams/default.yaml",
        "final team": "teams/final-team.yaml",
      },
    });

    service.deleteTeam("final team");
    expect(fs.existsSync(finalPath)).toBe(false);
    expect(readYaml(path.join(dataRoot, "config", "agents", "team_index.yaml"))).toMatchObject({
      teams: {
        default: "teams/default.yaml",
      },
    });
  });
});

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
