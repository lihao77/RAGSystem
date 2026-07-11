import { describe, expect, it } from "vitest";

import type { AgentConfig } from "../../src/contracts/agent-config.js";
import type { ModelProviderConfig } from "../../src/contracts/model-adapter.js";
import { RuntimeCoreService, type RuntimeAgentConfigPort, type RuntimeModelProviderPort } from "../../src/services/agent/execution/runtime-core-service.js";

class InMemoryAgentConfigs implements RuntimeAgentConfigPort {
  constructor(
    private readonly configs: Record<string, AgentConfig>,
    private readonly configsByTeam: Record<string, Record<string, AgentConfig>> = {},
  ) {}

  getConfig(agentName: string, options: { teamName?: string | null } = {}): AgentConfig | null {
    return this.selectConfigs(options.teamName)[agentName] ?? null;
  }

  listConfigs(options: { teamName?: string | null } = {}): Record<string, AgentConfig> {
    return structuredClone(this.selectConfigs(options.teamName)) as Record<string, AgentConfig>;
  }

  private selectConfigs(teamName?: string | null): Record<string, AgentConfig> {
    return teamName ? (this.configsByTeam[teamName] ?? {}) : this.configs;
  }
}

class InMemoryModelProviders implements RuntimeModelProviderPort {
  constructor(private readonly providers: ModelProviderConfig[]) {}

  listProviders(): ModelProviderConfig[] {
    return structuredClone(this.providers) as ModelProviderConfig[];
  }
}

describe("RuntimeCoreService ports", () => {
  it("resolves readiness through minimal agent/provider ports", () => {
    const service = new RuntimeCoreService(
      new InMemoryAgentConfigs({
        orchestrator_agent: minimalAgent("orchestrator_agent", true),
      }),
      new InMemoryModelProviders([minimalProvider()]),
    );

    const readiness = service.getReadiness();

    expect(readiness).toMatchObject({
      status: "ready",
      configuration_ready: true,
      agent: {
        agent_name: "orchestrator_agent",
        source: "agent_config",
      },
      llm: {
        provider: "my",
        provider_type: "deepseek",
        model_name: "deepseek-chat",
        source: "agent_config.default",
      },
      provider: {
        configured: true,
        provider_key: "my_deepseek",
        model_available: true,
        api_key_configured: true,
      },
    });
    expect(readiness.requirements.filter((item) => !item.satisfied)).toEqual([]);
  });

  it("uses selected LLM overrides without mutating the runtime ports", () => {
    const service = new RuntimeCoreService(
      new InMemoryAgentConfigs({
        orchestrator_agent: minimalAgent("orchestrator_agent", true),
      }),
      new InMemoryModelProviders([
        {
          ...minimalProvider(),
          name: "other",
          key: "other_deepseek",
          model_map: { chat: "deepseek-alt" },
          models: ["deepseek-alt"],
        },
      ]),
    );

    const resolved = service.resolveExecutionConfig({
      selectedLlm: "other|deepseek|deepseek-alt",
    });

    expect(resolved).toMatchObject({
      readiness: {
        configuration_ready: true,
        llm: {
          source: "selected_llm",
          provider: "other",
          model_name: "deepseek-alt",
        },
      },
      agent: {
        agent_name: "orchestrator_agent",
      },
      provider: {
        key: "other_deepseek",
      },
      modelName: "deepseek-alt",
    });
  });

  it("resolves entry agents from a session-scoped team view", () => {
    const service = new RuntimeCoreService(
      new InMemoryAgentConfigs(
        {
          orchestrator_agent: minimalAgent("orchestrator_agent", true),
        },
        {
          research: {
            research_agent: minimalAgent("research_agent", true),
          },
        },
      ),
      new InMemoryModelProviders([minimalProvider()]),
    );

    const resolved = service.resolveExecutionConfig({
      teamName: "research",
    });

    expect(resolved).toMatchObject({
      readiness: {
        configuration_ready: true,
        agent: {
          agent_name: "research_agent",
        },
      },
      agent: {
        agent_name: "research_agent",
      },
    });
  });
});

function minimalAgent(agentName: string, defaultEntry: boolean): AgentConfig {
  return {
    agent_name: agentName,
    display_name: agentName,
    description: null,
    enabled: true,
    default_entry: defaultEntry,
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
    skills: { enabled_skills: [] },
    mcp: { enabled_servers: [] },
    memory: {
      auto_inject: true,
      allowed_scopes: ["team", "session"],
      write_scopes: ["session"],
      archive_scopes: ["session"],
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
        system_prompt: "You are ready.",
      },
    },
  };
}

function minimalProvider(): ModelProviderConfig {
  return {
    name: "my",
    provider_type: "deepseek",
    key: "my_deepseek",
    api_key: "sk-test",
    models: ["deepseek-chat"],
    model_map: {
      chat: "deepseek-chat",
    },
  };
}
