import type { AgentConfig } from "../../../contracts/agent-config.js";
import type { RuntimeToolDefinition } from "../../runtime/runtime-tool-types.js";

export interface AgentPromptSkill {
  name: string;
  description?: string | null | undefined;
}

export interface AgentPromptDelegatedAgent {
  agent_name: string;
  display_name?: string | null | undefined;
  description?: string | null | undefined;
  use_cases?: unknown;
  tool_count?: number | null | undefined;
}

export interface AgentPromptContext {
  tools?: RuntimeToolDefinition[] | undefined;
  skills?: AgentPromptSkill[] | undefined;
  delegatedAgents?: AgentPromptDelegatedAgent[] | undefined;
}

export interface AgentPromptConfigResolver {
  getConfig(agentName: string, options?: { teamName?: string | null }): AgentConfig | null;
  listAvailableSkills?(): unknown[];
}
