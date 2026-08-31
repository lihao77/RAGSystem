import type { AgentConfigTeam } from "../../../contracts/agent/team-store.js";
import { isStockDefaultLlmTierMap } from "./configs.js";
import type { HydrationStep } from "../../config/hydration.js";

/**
 * Agent 配置的迁移步骤链：目标是整个 teams Map，每次加载全量执行。
 * 步骤可退役：保留到宣布最低支持版本为止；新增/退役必须同步登记
 * backend-core/MIGRATIONS.md（有清单自证测试锁定）。
 */
export const AGENT_CONFIG_MIGRATION_STEPS: readonly HydrationStep<Map<string, AgentConfigTeam>>[] = [
  {
    id: "strip_dangling_delegation_refs",
    note: "剔除 enabled_agents 中指向本 team 不存在 agent 的悬空引用",
    run: stripDanglingDelegationRefs,
  },
  {
    id: "strip_stock_default_llm_tier",
    note: "剥除与出厂 defaultLlmTier 全等的示例 default tier（指向不存在 provider 的失效引用），剥除后继承系统 LLM",
    run: stripStockLlmTiers,
  },
];

/** 剔除 enabled_agents 中指向本 team 不存在 agent 的悬空引用。 */
function stripDanglingDelegationRefs(teams: Map<string, AgentConfigTeam>): boolean {
  let changed = false;
  for (const configs of teams.values()) {
    const members = new Set(configs.keys());
    for (const [name, config] of configs) {
      const enabledAgents = config.delegation?.enabled_agents;
      if (!enabledAgents?.length) continue;
      const next = enabledAgents.filter((target) => members.has(target));
      if (next.length === enabledAgents.length) continue;
      changed = true;
      configs.set(name, {
        ...config,
        delegation: { ...config.delegation, enabled_agents: next },
      });
    }
  }
  return changed;
}

/** 剥除与出厂 defaultLlmTier 全等的示例 tier；用户改过参数或另有档位的不动。 */
function stripStockLlmTiers(teams: Map<string, AgentConfigTeam>): boolean {
  let changed = false;
  for (const configs of teams.values()) {
    for (const [name, config] of configs) {
      if (!isStockDefaultLlmTierMap(config.llm_tiers)) continue;
      changed = true;
      configs.set(name, { ...config, llm_tiers: null });
    }
  }
  return changed;
}
