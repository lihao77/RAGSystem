import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { AgentPromptConfigResolver, AgentPromptDelegatedAgent, AgentPromptSkill } from "./types.js";
import { isRecord, normalizeString } from "./helpers.js";

export function buildPromptSkills(agent: AgentConfig, configResolver?: AgentPromptConfigResolver | null): AgentPromptSkill[] {
  const enabledSkills = agent.skills.enabled_skills ?? [];
  if (!enabledSkills.length) {
    return [];
  }
  const byName = new Map<string, Record<string, unknown>>();
  for (const item of configResolver?.listAvailableSkills?.() ?? []) {
    if (!isRecord(item)) {
      continue;
    }
    const name = normalizeString(item.name);
    if (name) {
      byName.set(name, item);
    }
  }
  return enabledSkills.map((name) => ({
    name,
    description: normalizeString(byName.get(name)?.description) ?? "",
  }));
}

export function buildPromptDelegatedAgents(
  agent: AgentConfig,
  configResolver?: AgentPromptConfigResolver | null,
  teamName?: string | null,
): AgentPromptDelegatedAgent[] {
  const enabledAgents = agent.delegation.enabled_agents ?? [];
  if (!enabledAgents.length) {
    return [];
  }
  return enabledAgents
    .filter((agentName) => agentName && agentName !== agent.agent_name)
    .map((agentName) => {
      const config = configResolver?.getConfig(agentName, { teamName: normalizeString(teamName) }) ?? null;
      const behavior = isRecord(config?.custom_params.behavior) ? config.custom_params.behavior : {};
      return {
        agent_name: config?.agent_name ?? agentName,
        display_name: config?.display_name ?? agentName,
        description: config?.description ?? "",
        use_cases: behavior.use_cases,
      };
    });
}
