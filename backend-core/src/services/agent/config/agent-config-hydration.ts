import type { AgentConfigTeam } from "../../../contracts/agent/team-store.js";
import { isStockDefaultLlmTierMap } from "./configs.js";
import type { HydrationStep } from "../../config/hydration.js";
import { isRecord } from "../../../utils/guards.js";

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
  {
    id: "strip_empty_llm_tiers",
    note: "剥除 provider 与 model_name 均为空的零信息 tier 条目（Agent Studio 表单对未配置档位的落盘形态），map 剔空则置 null 以继承系统 LLM；半空（二者之一非空）保留并按缺失显式报错",
    run: stripEmptyLlmTiers,
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

/**
 * 剥除零信息 tier 条目：provider 与 model_name 均为空白视为"未配置"（与 llm_tiers:
 * null 语义等价，继承系统 LLM），剔除后 map 为空同样置 null。半空条目（两个字段只有
 * 一个非空）是真实的配置错误，保留原样交给 readiness 显式报缺失，不做静默兜底。
 */
function stripEmptyLlmTiers(teams: Map<string, AgentConfigTeam>): boolean {
  let changed = false;
  for (const configs of teams.values()) {
    for (const [name, config] of configs) {
      const tiers = config.llm_tiers;
      if (!isRecord(tiers)) continue;
      const entries = Object.entries(tiers);
      const kept = entries.filter(([, tier]) => !isRecord(tier) || !isZeroInfoTier(tier));
      // 无剔除且 map 非空 → 已是目标形态；空 map（0 键）同样归一为 null。
      if (kept.length === entries.length && entries.length > 0) continue;
      const next = kept.length > 0 ? Object.fromEntries(kept) : null;
      changed = true;
      configs.set(name, { ...config, llm_tiers: next });
    }
  }
  return changed;
}

/** tier 是否零信息：provider 与 model_name 均为空白（null/undefined/纯空白）。 */
function isZeroInfoTier(tier: Record<string, unknown>): boolean {
  return isBlankString(tier.provider) && isBlankString(tier.model_name);
}

function isBlankString(value: unknown): boolean {
  return value === null || value === undefined || String(value).trim() === "";
}
