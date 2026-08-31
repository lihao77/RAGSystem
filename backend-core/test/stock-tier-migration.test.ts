import { describe, expect, it } from "vitest";

import { AgentConfigSchema, type AgentConfig } from "../src/contracts/agent/agent-config.js";
import type { AgentConfigTeam, IAgentConfigTeamStore } from "../src/contracts/agent/team-store.js";
import type { AppliedHydrationStep } from "../src/services/config/hydration.js";
import { defaultLlmTier } from "../src/services/agent/config/configs.js";
import { AgentConfigService } from "../src/services/agent/config/index.js";

class PreloadedTeamStore implements IAgentConfigTeamStore {
  saveAllCalls = 0;
  lastAppliedMigrations: readonly AppliedHydrationStep[] | undefined;

  constructor(
    /** null = 无持久化（全新安装，保留构造时播种的内置默认 team）。 */
    private teams: Map<string, AgentConfigTeam> | null,
    private activeTeam = "default",
  ) {}

  async loadTeams() {
    return this.teams ? { teams: this.teams, activeTeam: this.activeTeam } : null;
  }

  async saveAll(
    _activeTeam: string,
    teams: Map<string, AgentConfigTeam>,
    appliedMigrations?: readonly AppliedHydrationStep[],
  ) {
    this.saveAllCalls += 1;
    this.lastAppliedMigrations = appliedMigrations;
    this.teams = teams;
  }

  async saveIndex() {}
  async removeTeam() {}
  async renameTeam() {}
  async getTeamLocation() { return null; }
}

describe("出厂示例 LLM tier 治理", () => {
  it("内置默认 team 的系统 Agent 不再携带示例 tier", async () => {
    const service = new AgentConfigService(new PreloadedTeamStore(null));
    await service.initialize();

    for (const config of Object.values(service.listConfigs())) {
      expect(config.llm_tiers).toBeNull();
    }
  });

  it("加载时剥除原样出厂的示例 tier 并一次性回写", async () => {
    const store = new PreloadedTeamStore(new Map([
      ["default", new Map([["orchestrator_agent", agentWithTier({ ...defaultLlmTier }, undefined, "orchestrator_agent")]])],
    ]));

    const service = new AgentConfigService(store);
    await service.initialize();

    expect(service.getConfig("orchestrator_agent")?.llm_tiers).toBeNull();
    expect(store.saveAllCalls).toBe(1);
    // 应用戳随迁移回写传给持久层，含生效步骤 id 与时间。
    expect(store.lastAppliedMigrations).toEqual([
      expect.objectContaining({ id: "strip_stock_default_llm_tier" }),
    ]);
    // 回写后的持久层也是干净的：二次加载不再触发迁移。
    const reloaded = new AgentConfigService(store);
    await reloaded.initialize();
    expect(store.saveAllCalls).toBe(1);
  });

  it("同一 team 同时存在两类脏数据时，一次加载全部治理且仅回写一次", async () => {
    // 旧实现用 || 串联两个治理步骤：短路会让同一次加载只治理先命中的一项。
    // 链化后所有步骤无条件执行，此夹具锁定该行为差异（改进）不回退。
    const dualDirty = AgentConfigSchema.parse({
      agent_name: "orchestrator_agent",
      display_name: "Agent",
      enabled: true,
      default_entry: true,
      llm_tiers: { default: { ...defaultLlmTier } },
      delegation: { enabled_agents: ["ghost_agent"], parallel_children: false },
      custom_params: {
        behavior: { system_prompt: "You are an agent." },
      },
    });
    const store = new PreloadedTeamStore(new Map([
      ["default", new Map([["orchestrator_agent", dualDirty]])],
    ]));

    const service = new AgentConfigService(store);
    await service.initialize();

    const config = service.getConfig("orchestrator_agent");
    expect(config?.llm_tiers).toBeNull();
    expect(config?.delegation?.enabled_agents).toEqual([]);
    expect(store.saveAllCalls).toBe(1);
    expect(store.lastAppliedMigrations?.map((item) => item.id)).toEqual([
      "strip_dangling_delegation_refs",
      "strip_stock_default_llm_tier",
    ]);
    expect(store.lastAppliedMigrations?.every((item) => typeof item.applied_at === "string")).toBe(true);
  });

  it("用户修改过或另有档位的 tier 不受迁移影响", async () => {
    const store = new PreloadedTeamStore(new Map([
      ["default", new Map([
        ["tuned_agent", agentWithTier({ ...defaultLlmTier, temperature: 0.9 }, undefined, "tuned_agent")],
        ["multi_tier_agent", agentWithTier(null, {
          fast: { ...defaultLlmTier },
        }, "multi_tier_agent")],
        ["real_agent", agentWithTier({ ...defaultLlmTier, provider: "real", model_name: "real-model" }, undefined, "real_agent")],
      ])],
    ]));

    const service = new AgentConfigService(store);
    await service.initialize();

    expect(service.getConfig("tuned_agent")?.llm_tiers?.default?.temperature).toBe(0.9);
    expect(service.getConfig("multi_tier_agent")?.llm_tiers).toHaveProperty("fast");
    expect(service.getConfig("real_agent")?.llm_tiers?.default?.provider).toBe("real");
  });

  it("预设只调整已存在的 tier，不为继承系统配置的 Agent 物化示例引用", async () => {
    const store = new PreloadedTeamStore(new Map([
      ["default", new Map([
        ["tierless_agent", agentWithTier(null, undefined, "tierless_agent")],
        ["tiered_agent", agentWithTier({ ...defaultLlmTier, provider: "real", model_name: "real-model", temperature: 0.7 }, undefined, "tiered_agent")],
      ])],
    ]));
    const service = new AgentConfigService(store);
    await service.initialize();

    await service.applyPreset("tierless_agent", "fast");
    expect(service.getConfig("tierless_agent")?.llm_tiers).toBeNull();

    await service.applyPreset("tiered_agent", "fast");
    const tier = service.getConfig("tiered_agent")?.llm_tiers?.default;
    expect(tier?.temperature).toBe(0.1);
    expect(tier?.max_completion_tokens).toBe(2048);
    expect(tier?.provider).toBe("real");
  });
});

function agentWithTier(
  defaultTier: Record<string, unknown> | null,
  tiers?: Record<string, unknown>,
  agentName = "agent",
): AgentConfig {
  return AgentConfigSchema.parse({
    agent_name: agentName,
    display_name: "Agent",
    enabled: true,
    default_entry: true,
    ...(tiers
      ? { llm_tiers: tiers }
      : defaultTier
        ? { llm_tiers: { default: defaultTier } }
        : {}),
    custom_params: {
      behavior: { system_prompt: "You are an agent." },
    },
  });
}
