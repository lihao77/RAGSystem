import type { AgentConfigPort } from "@ragsystem/backend-core/contracts/agent/agent-config.js";
import type { CapabilityRegistry } from "@ragsystem/backend-core/plugins/capability-registry.js";
import type { BackendToolDescriptor } from "@ragsystem/backend-core/plugins/backend-plugin.js";
import { MCP_RUNTIME_CAPABILITY } from "@ragsystem/backend-plugin-mcp/capability.js";
import { SKILLS_RUNTIME_CAPABILITY } from "@ragsystem/backend-plugin-skills/capability.js";

import type { AgentBuilderBindings } from "./service.js";

export async function createAgentBuilderBindings(input: {
  agentConfig: AgentConfigPort;
  capabilities: CapabilityRegistry;
  pluginTools?: readonly BackendToolDescriptor[];
}): Promise<AgentBuilderBindings> {
  const skills = input.capabilities.get(SKILLS_RUNTIME_CAPABILITY);
  const mcp = input.capabilities.get(MCP_RUNTIME_CAPABILITY);
  const skillNames = skills
    ? new Set((await skills.library.listSkills()).map((skill) => skill.name))
    : undefined;
  const mcpServerNames = mcp
    ? new Set(mcp.service.listServers().map((server) => server.name))
    : undefined;
  const toolNames = input.pluginTools
    ? new Set([
        ...input.agentConfig.listAvailableTools().map((tool) => tool.name),
        ...input.pluginTools.map((tool) => tool.name),
      ])
    : undefined;

  return {
    inventory: {
      ...(toolNames ? { tools: toolNames } : {}),
      ...(skillNames ? { skills: skillNames } : {}),
      ...(mcpServerNames ? { mcpServers: mcpServerNames } : {}),
    },
    async getSkillConfig(teamName, agentName) {
      if (!skills) return [];
      return (await skills.agentConfig.getEffective({
        teamName,
        agentName,
      })).enabled_skills;
    },
    async putSkillConfig(teamName, agentName, enabledSkills) {
      if (!skills) {
        if (enabledSkills.length > 0) throw new Error("Skills plugin is not installed");
        return;
      }
      await skills.agentConfig.put(
        { teamName, agentName },
        { enabled_skills: enabledSkills },
      );
    },
    async getMcpConfig(teamName, agentName) {
      if (!mcp) return [];
      return (await mcp.agentConfig.getEffective({
        teamName,
        agentName,
      })).enabled_servers;
    },
    async putMcpConfig(teamName, agentName, enabledServers) {
      if (!mcp) {
        if (enabledServers.length > 0) throw new Error("MCP plugin is not installed");
        return;
      }
      await mcp.agentConfig.put(
        { teamName, agentName },
        { enabled_servers: enabledServers },
      );
    },
  };
}
