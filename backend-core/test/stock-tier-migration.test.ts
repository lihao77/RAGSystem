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
  it("空库不兜底任何出厂 team：读路径按不存在明确报错", async () => {
    const service = new AgentConfigService(new PreloadedTeamStore(null));
    await service.initialize();

    // 内核只提供配置机制；default team 等产品形态由产品层 ensure（组合层/插件/桌面端）。
    // 没有任何 team 是合法状态——使用期报清晰错误，而不是静默兜底一个内核编造的 team。
    expect(() => service.listConfigs()).toThrow(/team 'default' 不存在/);
    await expect(service.listTeams()).resolves.toHaveProperty("teams", []);
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
    // 锁定链内核的关键语义：所有步骤无条件按序执行、改动合并为一次回写。
    // 防止未来有人把链执行改回条件短路（任一步骤命中就跳过后续），让同一次
    // 加载只治理部分脏数据。
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
});

describe("零信息 LLM tier 治理", () => {
  it("provider 与 model_name 均空的 default tier 剔除后置 null，继承系统 LLM", async () => {
    // 历史形状：Agent Studio 对未配置档位的落盘形态——字段全空串，
    // provider_type 可能残留旧值（孤儿 type 不参与解析，同样视为零信息）。
    const store = new PreloadedTeamStore(new Map([
      ["default", new Map([
        ["empty_agent", agentWithTier({
          provider: "",
          provider_type: "deepseek",
          model_name: "",
          temperature: 0.2,
          max_completion_tokens: 4096,
          max_context_tokens: 128000,
          extra_params: {},
        }, undefined, "empty_agent")],
      ])],
    ]));

    const service = new AgentConfigService(store);
    await service.initialize();

    expect(service.getConfig("empty_agent")?.llm_tiers).toBeNull();
    expect(store.lastAppliedMigrations?.map((item) => item.id)).toEqual(["strip_empty_llm_tiers"]);
    // 回写后幂等：二次加载不再触发。
    const reloaded = new AgentConfigService(store);
    await reloaded.initialize();
    expect(store.saveAllCalls).toBe(1);
  });

  it("空条目与真实档位混存时只剔空，真实档位保留", async () => {
    const store = new PreloadedTeamStore(new Map([
      ["default", new Map([
        ["mixed_agent", agentWithTier(null, {
          default: { provider: "", provider_type: "", model_name: "" },
          fast: { provider: "real", provider_type: "vendor", model_name: "real-model" },
        }, "mixed_agent")],
      ])],
    ]));

    const service = new AgentConfigService(store);
    await service.initialize();

    const tiers = service.getConfig("mixed_agent")?.llm_tiers;
    expect(tiers).not.toHaveProperty("default");
    expect(tiers?.fast).toMatchObject({ provider: "real", model_name: "real-model" });
  });

  it("空 map（无任何档位键）同样归一为 null", async () => {
    const store = new PreloadedTeamStore(new Map([
      ["default", new Map([["agent", agentWithTier(null, {}, "agent")]])],
    ]));

    const service = new AgentConfigService(store);
    await service.initialize();

    expect(service.getConfig("agent")?.llm_tiers).toBeNull();
  });

  it("半空条目（provider 与 model_name 仅其一非空）是真实配置错误，不做兜底剥除", async () => {
    const store = new PreloadedTeamStore(new Map([
      ["default", new Map([
        ["half_agent", agentWithTier({
          provider: "real",
          provider_type: "vendor",
          model_name: "",
        }, undefined, "half_agent")],
      ])],
    ]));

    const service = new AgentConfigService(store);
    await service.initialize();

    // 保留原样：静默剥除会掩盖配置问题，运行期由 readiness 显式报缺失。
    expect(service.getConfig("half_agent")?.llm_tiers?.default).toMatchObject({
      provider: "real",
      model_name: "",
    });
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
